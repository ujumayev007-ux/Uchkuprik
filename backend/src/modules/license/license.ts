import { createPublicKey, verify } from 'node:crypto';
import { setDeniedPermissions } from '../auth/permissions.js';
import { setLockedOrderSettings } from '../orders/settings.js';
import type { Services } from '../../context.js';
import { hiddenMenuPaths } from '../control/policy.js';
import {
  planFeatures,
  type Entitlements,
  type PlanFeature,
} from '../billing/entitlements.js';

// Vendor's Ed25519 public key. Licences are signed with the matching private key,
// which exists only on the vendor's computer (%USERPROFILE%\.fastfood).
const VENDOR_PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoi+PtuCXdUbF1mWLRmj1yOHATIOKWG91OEGLRANYieM=
-----END PUBLIC KEY-----`);

const DAY = 86_400_000;
const TRIAL_DAYS = 14;
const WARN_DAYS = 5;

export type LicensePayload = {
  v: 1;
  customer: string;
  installId: string;
  issuedAt: string;
  // Last valid day (inclusive), YYYY-MM-DD.
  expiresAt: string;
  features: string[];
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
  // Where the vendor publishes signed remote updates (renewals, blocking).
  statusUrl?: string;
  // Menu entries (paths) the vendor switched off for this customer.
  hiddenMenus?: string[];
  // Settings the vendor fixed (restaurant admins cannot change them).
  settings?: { orders?: Record<string, boolean> };
  // Permissions removed from every user of this install.
  deniedPermissions?: string[];
};

export type LicenseStatus = {
  status:
    | 'TRIAL'
    | 'VALID'
    | 'EXPIRING'
    | 'EXPIRED'
    | 'MISSING'
    | 'INVALID'
    | 'BLOCKED';
  customer: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  installId: string;
  features: PlanFeature[] | null;
  hiddenMenus: string[];
};

/** Parses and verifies `<base64url payload>.<base64url signature>`. */
export function verifyLicense(key: string): LicensePayload | null {
  const [body, signature] = key.trim().split('.');
  if (!body || !signature) return null;
  try {
    const ok = verify(
      null,
      Buffer.from(body, 'base64url'),
      VENDOR_PUBLIC_KEY,
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) return null;
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as LicensePayload;
    return payload.v === 1 ? payload : null;
  } catch {
    return null;
  }
}

let cache: { at: number; value: LicenseStatus } | null = null;

export function clearLicenseCache() {
  cache = null;
}

/** Current licence of this self-hosted install (cached for one minute). */
export async function licenseStatus(
  services: Services,
): Promise<LicenseStatus> {
  const now = services.now?.() ?? new Date();
  if (cache && now.getTime() - cache.at < 60_000) return cache.value;
  const installId = services.installId ?? 'unknown';
  const row = await services.db.appLicense.findUnique({ where: { id: 1 } });
  // The clock may only move forward: remember the latest time seen.
  const effective = new Date(
    Math.max(now.getTime(), row?.lastSeenAt.getTime() ?? 0),
  );
  if (row && now.getTime() > row.lastSeenAt.getTime() + 60 * 60_000)
    await services.db.appLicense.update({
      where: { id: 1 },
      data: { lastSeenAt: now },
    });
  let value: LicenseStatus;
  const payload = row?.key ? verifyLicense(row.key) : null;
  if (payload && payload.installId === installId) {
    const end = new Date(`${payload.expiresAt}T23:59:59.999+05:00`).getTime();
    const daysLeft = Math.ceil((end - effective.getTime()) / DAY);
    value = {
      status:
        daysLeft <= 0
          ? 'EXPIRED'
          : daysLeft <= WARN_DAYS
            ? 'EXPIRING'
            : 'VALID',
      customer: payload.customer,
      expiresAt: payload.expiresAt,
      daysLeft: Math.max(0, daysLeft),
      installId,
      features: payload.features.filter((key): key is PlanFeature =>
        (planFeatures as readonly string[]).includes(key),
      ),
      hiddenMenus: (payload.hiddenMenus ?? []).filter((path) =>
        /^\/[a-z0-9/-]*$/.test(path),
      ),
    };
  } else {
    // No (or foreign) licence: free trial from the first installation.
    const installed = services.installedAt?.getTime() ?? effective.getTime();
    const daysLeft = Math.ceil(
      (installed + TRIAL_DAYS * DAY - effective.getTime()) / DAY,
    );
    value = {
      status: row?.key ? 'INVALID' : daysLeft > 0 ? 'TRIAL' : 'MISSING',
      customer: null,
      expiresAt: null,
      daysLeft: Math.max(0, daysLeft),
      installId,
      features: null,
      hiddenMenus: [],
    };
    if (row?.key && daysLeft > 0) value.status = 'TRIAL';
  }
  // Vendor locks and permission switches follow the current licence.
  const applied = payload && payload.installId === installId ? payload : null;
  setLockedOrderSettings(applied?.settings?.orders ?? {});
  setDeniedPermissions(applied?.deniedPermissions ?? []);
  // Linked to the central server: its grant defines term, modules and hidden menus
  // (blocking and offline rules are enforced by the control layer itself).
  const linked = await services.controlRuntime?.state();
  if (linked && linked.mode !== 'UNLINKED' && linked.grant) {
    const end = new Date(linked.grant.licenseExpiresAt).getTime();
    const daysLeft = Math.ceil((end - effective.getTime()) / DAY);
    value = {
      ...value,
      customer: linked.grant.customerName,
      expiresAt: linked.grant.licenseExpiresAt.slice(0, 10),
      daysLeft: Math.max(0, daysLeft),
      status:
        daysLeft <= 0
          ? 'EXPIRED'
          : daysLeft <= WARN_DAYS
            ? 'EXPIRING'
            : 'VALID',
      features: linked.grant.features.filter((key): key is PlanFeature =>
        (planFeatures as readonly string[]).includes(key),
      ),
      hiddenMenus: [
        ...new Set([...value.hiddenMenus, ...hiddenMenuPaths(linked.policy)]),
      ],
    };
  }
  // The vendor blocked this install remotely (e.g. unpaid month).
  if (row?.remoteBlocked) value.status = 'BLOCKED';
  cache = { at: now.getTime(), value };
  return value;
}

export function licenseAllowsUse(status: LicenseStatus) {
  return (
    status.status === 'TRIAL' ||
    status.status === 'VALID' ||
    status.status === 'EXPIRING'
  );
}

/** Entitlements of a self-hosted install come from its licence (null features = all). */
export async function licenseEntitlements(
  services: Services,
): Promise<Entitlements> {
  const status = await licenseStatus(services);
  // A central grant overrides the locally entered key's modules and limits.
  const linked = await services.controlRuntime?.state();
  if (linked && linked.mode !== 'UNLINKED' && linked.grant)
    return {
      planCode: 'CENTRAL',
      status: status.status,
      features: status.features,
      limits: linked.grant.limits,
    };
  const row = await services.db.appLicense.findUnique({ where: { id: 1 } });
  const payload = row?.key ? verifyLicense(row.key) : null;
  const valid =
    payload && payload.installId === (services.installId ?? 'unknown');
  return {
    planCode: valid ? 'LICENSE' : null,
    status: status.status,
    features: valid ? status.features : null,
    limits: {
      branches: valid ? payload.maxBranches : null,
      users: valid ? payload.maxUsers : null,
      devices: valid ? payload.maxDevices : null,
    },
  };
}

type StatusDocument = {
  v: 1;
  issuedAt: string;
  entries: Record<string, { blocked?: boolean; key?: string }>;
};

/**
 * Applies the vendor's signed status document: a newer licence key for this install
 * (renewal without typing a key) and the remote block flag. Older documents are
 * ignored, so replaying an old file cannot unblock or downgrade anything.
 */
export async function syncLicense(services: Services) {
  const installId = services.installId;
  if (!installId) return 'no-install';
  const row = await services.db.appLicense.findUnique({ where: { id: 1 } });
  const current = row?.key ? verifyLicense(row.key) : null;
  const url = current?.statusUrl ?? services.licenseStatusUrl;
  if (!url || !/^https:\/\//.test(url)) return 'no-url';
  let text: string;
  try {
    const response = await fetch(
      `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`,
      {
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return 'unreachable';
    text = (await response.text()).trim();
  } catch {
    return 'offline';
  }
  const [body, signature] = text.split('.');
  if (!body || !signature) return 'invalid';
  if (
    !verify(
      null,
      Buffer.from(body, 'base64url'),
      VENDOR_PUBLIC_KEY,
      Buffer.from(signature, 'base64url'),
    )
  )
    return 'invalid';
  const doc = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  ) as StatusDocument;
  const issuedAt = new Date(doc.issuedAt);
  if (doc.v !== 1 || Number.isNaN(issuedAt.getTime())) return 'invalid';
  if (row?.statusIssuedAt && issuedAt <= row.statusIssuedAt) return 'unchanged';
  const entry = doc.entries[installId];
  let key = row?.key ?? '';
  const offered = entry?.key ? verifyLicense(entry.key) : null;
  if (
    offered &&
    offered.installId === installId &&
    (!current || offered.issuedAt > current.issuedAt)
  )
    key = entry!.key!;
  await services.db.appLicense.upsert({
    where: { id: 1 },
    update: { key, remoteBlocked: !!entry?.blocked, statusIssuedAt: issuedAt },
    create: {
      id: 1,
      key,
      remoteBlocked: !!entry?.blocked,
      statusIssuedAt: issuedAt,
    },
  });
  clearLicenseCache();
  return 'applied';
}

export function startLicenseSync(
  services: Services,
  // Vendor changes reach installs within minutes.
  intervalMs = 10 * 60_000,
) {
  const tick = () =>
    void syncLicense(services).catch(() =>
      services.logger.warn('Licence sync failed'),
    );
  const first = setTimeout(tick, 20_000);
  first.unref();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
