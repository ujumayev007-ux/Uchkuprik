import { defaultPolicy, sanitizeFeatures, type PolicyDoc } from './policy.js';
import { verifyDocument } from './keys.js';
import type { KeyObject } from 'node:crypto';

// Explicit timing of the control channel (all in milliseconds).
export const timing = {
  // How often an install checks in with the central server.
  heartbeatIntervalMs: 60_000,
  // Brief network failures are tolerated: for this long after the last successful
  // check the install keeps full online rules and nothing changes for the user.
  networkToleranceMs: 5 * 60_000,
  // Central presence: a device is "online" if it was heard from within this window
  // (three missed checks mean offline).
  presenceWindowMs: 3 * 60_000,
  // Grants of online-only customers are valid for this long after each check, which
  // covers the tolerance window plus one missed check.
  onlineOnlyGrantMs: 10 * 60_000,
  // Accepted difference between device and server clocks for signed requests.
  requestSkewMs: 5 * 60_000,
  // System clock behind the highest time ever seen by more than this is tampering.
  clockRollbackMs: 10 * 60_000,
} as const;

export type GrantStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | 'BLOCKED';

export type Grant = {
  t: 'grant';
  v: 1;
  customerId: string;
  customerName: string;
  licenseId: string;
  activationId: string;
  // Fingerprint of the device key the grant is bound to.
  fingerprint: string;
  issuedAt: string;
  // Offline authorization ends here (renewed on every successful check).
  expiresAt: string;
  // The paid period ends here; nothing works afterwards.
  licenseExpiresAt: string;
  status: GrantStatus;
  features: string[];
  limits: {
    branches: number | null;
    users: number | null;
    devices: number | null;
  };
  policy: PolicyDoc;
};

export function readGrant(
  document: string,
  trusted: (string | KeyObject)[],
): Grant | null {
  const grant = verifyDocument<Grant>(document, trusted);
  if (!grant || grant.t !== 'grant' || grant.v !== 1) return null;
  return {
    ...grant,
    policy: {
      ...defaultPolicy(),
      ...grant.policy,
      features: sanitizeFeatures(grant.policy?.features),
    },
  };
}

export type ControlMode =
  'UNLINKED' | 'ONLINE' | 'OFFLINE' | 'EXPIRED' | 'BLOCKED';

export type ControlReason =
  | 'INVALID_GRANT'
  | 'SERVER_BLOCK'
  | 'LICENSE_EXPIRED'
  | 'CLOCK'
  | 'GRANT_EXPIRED'
  | 'OFFLINE_DISABLED';

export type ControlState = {
  mode: ControlMode;
  reason: ControlReason | null;
  grant: Grant | null;
  policy: PolicyDoc;
  // Offline authorization end (OFFLINE and ONLINE modes), when known.
  offlineUntil: Date | null;
  effectiveNow: Date;
};

export type LinkSnapshot = {
  grant: string;
  highWater: Date;
  lastContactAt: Date | null;
  serverStatus: string;
};

/**
 * Pure state machine of an install linked to the centre.
 *
 * `monotonicNow` is the install's own never-decreasing clock (system time, the
 * highest time ever seen and elapsed process time): rolling the system clock back
 * cannot extend a grant. A clock found behind the high-water mark at start-up needs
 * a fresh contact with the server before new operations are allowed.
 */
export function resolveControlState(input: {
  link: LinkSnapshot | null;
  trusted: (string | KeyObject)[];
  monotonicNow: Date;
  clockSuspect: boolean;
  expectedFingerprint?: string | undefined;
  readGrantDoc?: typeof readGrant;
}): ControlState {
  const { link, trusted, monotonicNow, clockSuspect } = input;
  const none: ControlState = {
    mode: 'UNLINKED',
    reason: null,
    grant: null,
    policy: defaultPolicy(),
    offlineUntil: null,
    effectiveNow: monotonicNow,
  };
  if (!link) return none;
  const grant = (input.readGrantDoc ?? readGrant)(link.grant, trusted);
  const invalid: ControlState = {
    ...none,
    mode: 'EXPIRED',
    reason: 'INVALID_GRANT',
  };
  if (!grant) return invalid;
  if (
    input.expectedFingerprint &&
    grant.fingerprint !== input.expectedFingerprint
  )
    return invalid;
  const base = { grant, policy: grant.policy, effectiveNow: monotonicNow };
  const expiresAt = new Date(grant.expiresAt);
  if (grant.status !== 'ACTIVE' || link.serverStatus !== 'ACTIVE')
    return {
      ...base,
      mode: 'BLOCKED',
      reason: 'SERVER_BLOCK',
      offlineUntil: null,
    };
  if (monotonicNow.getTime() > new Date(grant.licenseExpiresAt).getTime())
    return {
      ...base,
      mode: 'EXPIRED',
      reason: 'LICENSE_EXPIRED',
      offlineUntil: null,
    };
  const sinceContact = link.lastContactAt
    ? monotonicNow.getTime() - link.lastContactAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (clockSuspect && sinceContact > timing.networkToleranceMs)
    return { ...base, mode: 'EXPIRED', reason: 'CLOCK', offlineUntil: null };
  if (sinceContact <= timing.networkToleranceMs)
    return { ...base, mode: 'ONLINE', reason: null, offlineUntil: expiresAt };
  if (!grant.policy.offlineEnabled)
    return {
      ...base,
      mode: 'EXPIRED',
      reason: 'OFFLINE_DISABLED',
      offlineUntil: null,
    };
  if (monotonicNow.getTime() <= expiresAt.getTime())
    return { ...base, mode: 'OFFLINE', reason: null, offlineUntil: expiresAt };
  return {
    ...base,
    mode: 'EXPIRED',
    reason: 'GRANT_EXPIRED',
    offlineUntil: expiresAt,
  };
}

/** Compares dotted versions: 1 when a > b, -1 when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
