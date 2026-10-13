import { createPublicKey, verify } from 'node:crypto';
import type { Services } from '../../context.js';
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
};

export type LicenseStatus = {
  status: 'TRIAL' | 'VALID' | 'EXPIRING' | 'EXPIRED' | 'MISSING' | 'INVALID';
  customer: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  installId: string;
  features: PlanFeature[] | null;
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
  const payload = row ? verifyLicense(row.key) : null;
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
    };
  } else {
    // No (or foreign) licence: free trial from the first installation.
    const installed = services.installedAt?.getTime() ?? effective.getTime();
    const daysLeft = Math.ceil(
      (installed + TRIAL_DAYS * DAY - effective.getTime()) / DAY,
    );
    value = {
      status: row ? 'INVALID' : daysLeft > 0 ? 'TRIAL' : 'MISSING',
      customer: null,
      expiresAt: null,
      daysLeft: Math.max(0, daysLeft),
      installId,
      features: null,
    };
    if (row && daysLeft > 0) value.status = 'TRIAL';
  }
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
  const row = await services.db.appLicense.findUnique({ where: { id: 1 } });
  const payload = row ? verifyLicense(row.key) : null;
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
