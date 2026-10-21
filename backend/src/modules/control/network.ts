import { networkInterfaces } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import type { Services } from '../../context.js';
import { AppError } from '../../http/errors.js';
import type { AuthContext } from '../auth/session.js';

// Restaurant operations are limited to the restaurant's own network. The decision uses
// the address of the TCP connection itself (never a header, a Wi-Fi name or anything
// the client sends) and the server's own network cards. Only the vendor (Owner) can
// grant a time-limited exception, which still requires an authenticated session.

export type NetworkOverride = {
  expiresAt: string;
  grantedAt: string;
  // Empty = every role of the install; otherwise only users holding one of these roles.
  roles: string[];
  reason: string;
};
export type NetworkPolicy = { override: NetworkOverride | null };

export const defaultNetwork = (): NetworkPolicy => ({ override: null });

const ROLE = /^[a-z0-9_-]{1,40}$/;

/** Tolerant reader: older policies and damaged data mean "no override". */
export function normalizeNetwork(value: unknown): NetworkPolicy {
  const raw = (value as { override?: unknown } | null | undefined)?.override;
  if (typeof raw !== 'object' || raw === null) return defaultNetwork();
  const o = raw as Record<string, unknown>;
  const expires =
    typeof o.expiresAt === 'string' ? Date.parse(o.expiresAt) : NaN;
  if (!Number.isFinite(expires)) return defaultNetwork();
  return {
    override: {
      expiresAt: new Date(expires).toISOString(),
      grantedAt:
        typeof o.grantedAt === 'string' &&
        Number.isFinite(Date.parse(o.grantedAt))
          ? new Date(o.grantedAt).toISOString()
          : new Date(0).toISOString(),
      roles: Array.isArray(o.roles)
        ? o.roles
            .filter((r): r is string => typeof r === 'string' && ROLE.test(r))
            .slice(0, 20)
        : [],
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
    },
  };
}

export function activeOverride(
  policy: NetworkPolicy,
  now: Date,
): NetworkOverride | null {
  const override = policy.override;
  return override && Date.parse(override.expiresAt) > now.getTime()
    ? override
    : null;
}

// ----------------------------------------------------------------- addresses

type Subnet4 = { network: number; mask: number };
type Subnet6 = { prefix: string };

const toInt = (ip: string) =>
  ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const isV4 = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

/** Expands an IPv6 address to 8 groups of 4 hex digits (no zone id). */
function expandV6(address: string): string[] | null {
  const bare = (address.split('%')[0] ?? '').toLowerCase();
  if (!/^[0-9a-f:]+$/.test(bare) || bare.split('::').length > 2) return null;
  const [head = '', tail = ''] = bare.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const missing = 8 - a.length - b.length;
  if (bare.includes('::') ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...a,
    ...Array(bare.includes('::') ? missing : 0).fill('0'),
    ...b,
  ];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}

export function subnetsOf(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
) {
  const v4: Subnet4[] = [];
  const v6: Subnet6[] = [];
  for (const list of Object.values(interfaces))
    for (const item of list ?? []) {
      if (item.internal) continue;
      if (item.family === 'IPv4' && isV4(item.address) && isV4(item.netmask)) {
        const mask = toInt(item.netmask);
        v4.push({ network: (toInt(item.address) & mask) >>> 0, mask });
      } else if (item.family === 'IPv6') {
        const groups = expandV6(item.address);
        if (groups) v6.push({ prefix: groups.slice(0, 4).join(':') });
      }
    }
  return { v4, v6 };
}

let cached: { at: number; value: ReturnType<typeof subnetsOf> } | null = null;
const localSubnets = () => {
  if (!cached || Date.now() - cached.at > 10_000)
    cached = { at: Date.now(), value: subnetsOf() };
  return cached.value;
};

/**
 * Is this connection from the restaurant's own network? Loopback (the server computer
 * itself), or an address inside one of the server's network cards' subnets. A private
 * address of another network (a VPN, a neighbour's Wi-Fi, a forwarded port) is not.
 */
export function isLocalClient(
  remote: string | undefined,
  subnets: ReturnType<typeof subnetsOf> = localSubnets(),
): boolean {
  if (!remote) return false;
  const text = remote.replace(/^::ffff:/i, '');
  if (isV4(text)) {
    if (text.split('.')[0] === '127') return true;
    const ip = toInt(text);
    return subnets.v4.some((net) => (ip & net.mask) >>> 0 === net.network);
  }
  const groups = expandV6(text);
  if (!groups) return false;
  if (groups.join(':') === '0000:0000:0000:0000:0000:0000:0000:0001')
    return true;
  // fe80::/10 is link-local: it can not leave the local link.
  if (parseInt(groups[0]!, 16) >= 0xfe80 && parseInt(groups[0]!, 16) <= 0xfebf)
    return true;
  return subnets.v6.some((net) => net.prefix === groups.slice(0, 4).join(':'));
}

// ------------------------------------------------------------------ decision

export type NetworkDecision =
  | { allowed: true; via: 'LOCAL' | 'OVERRIDE' | 'NOT_APPLICABLE' }
  | {
      allowed: false;
      reason: 'OUTSIDE_NETWORK' | 'OVERRIDE_ROLE' | 'OVERRIDE_NEEDS_LOGIN';
    };

// Needed to sign in under an override; everything else needs the signed-in session.
const LOGIN_PATHS = ['/api/auth/', '/api/pin/'];

export async function policyOf(services: Services): Promise<NetworkPolicy> {
  const state = await services.controlRuntime?.state().catch(() => null);
  return normalizeNetwork(
    (state?.policy as { network?: unknown } | undefined)?.network,
  );
}

export async function decideNetwork(
  services: Services,
  input: {
    remote: string | undefined;
    path: string;
    auth: AuthContext | undefined;
  },
): Promise<NetworkDecision> {
  // Hosted (cloud) restaurants are reached over the internet by design.
  if (!services.selfHosted) return { allowed: true, via: 'NOT_APPLICABLE' };
  if (isLocalClient(input.remote)) return { allowed: true, via: 'LOCAL' };
  const override = activeOverride(
    await policyOf(services),
    services.now?.() ?? new Date(),
  );
  if (!override) return { allowed: false, reason: 'OUTSIDE_NETWORK' };
  if (!input.auth) {
    return LOGIN_PATHS.some((prefix) => input.path.startsWith(prefix))
      ? { allowed: true, via: 'OVERRIDE' }
      : { allowed: false, reason: 'OVERRIDE_NEEDS_LOGIN' };
  }
  if (
    override.roles.length > 0 &&
    !input.auth.roleKeys.some((role) => override.roles.includes(role))
  )
    return { allowed: false, reason: 'OVERRIDE_ROLE' };
  return { allowed: true, via: 'OVERRIDE' };
}

/** Express guard, mounted after the session is loaded and before the routes. */
export function enforceNetwork(services: Services) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!services.selfHosted) return next();
    // Diagnostics answer from anywhere: they say why a device is not approved.
    if (req.path === '/network/status') return next();
    const decision = await decideNetwork(services, {
      remote: req.socket.remoteAddress,
      path: req.originalUrl.split('?')[0] ?? req.path,
      auth: res.locals.auth as AuthContext | undefined,
    });
    if (decision.allowed) return next();
    throw new AppError(403, 'NETWORK_NOT_APPROVED', 'networkNotApproved');
  };
}

/** What the connecting device is told: no addresses of the restaurant's network. */
export async function networkStatus(
  services: Services,
  remote: string | undefined,
  auth: AuthContext | undefined,
) {
  const override = activeOverride(
    await policyOf(services),
    services.now?.() ?? new Date(),
  );
  const decision = await decideNetwork(services, {
    remote,
    path: '/api/network/status',
    auth,
  });
  return {
    approved: decision.allowed,
    via: decision.allowed ? decision.via : null,
    reason: decision.allowed ? null : decision.reason,
    yourAddress: remote?.replace(/^::ffff:/i, '') ?? null,
    override: override ? { expiresAt: override.expiresAt } : null,
  };
}
