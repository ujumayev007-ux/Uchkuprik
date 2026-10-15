import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type {
  ControlActivation,
  ControlCustomer,
  ControlLicense,
} from '../../generated/prisma/client.js';
import { planFeatures } from '../billing/entitlements.js';
import { timing, type Grant, type GrantStatus } from './grant.js';
import { fingerprintOf, signDocument } from './keys.js';
import { defaultPolicy, sanitizeFeatures, type PolicyDoc } from './policy.js';

export async function loadPolicy(
  db: Db | Tx,
  customerId: string,
): Promise<PolicyDoc> {
  const row = await db.controlPolicy.findUnique({ where: { customerId } });
  if (!row) return defaultPolicy();
  return {
    version: row.version,
    features: sanitizeFeatures(row.features),
    offlineEnabled: row.offlineEnabled,
    maxOfflineMinutes: row.maxOfflineMinutes,
    minAppVersion: row.minAppVersion,
    minVersionFrom: row.minVersionFrom?.toISOString() ?? null,
  };
}

/** What the licence allows right now, from the centre's point of view. */
export function grantStatusOf(
  customer: Pick<ControlCustomer, 'status'>,
  license: Pick<ControlLicense, 'status'>,
  activation: Pick<ControlActivation, 'status'>,
): GrantStatus {
  if (activation.status === 'BLOCKED') return 'BLOCKED';
  if (activation.status === 'REPLACED' || activation.status === 'REVOKED')
    return 'REVOKED';
  if (license.status === 'REVOKED') return 'REVOKED';
  if (customer.status !== 'ACTIVE' || license.status === 'SUSPENDED')
    return 'SUSPENDED';
  return 'ACTIVE';
}

/** The licence is valid through the whole last day (Tashkent time, UTC+5). */
export function licenseEnd(expiresAt: Date): Date {
  return expiresAt;
}

export function issueGrant(
  services: Services,
  input: {
    customer: ControlCustomer;
    license: ControlLicense;
    activation: ControlActivation;
    policy: PolicyDoc;
    at: Date;
  },
): { document: string; grant: Grant } {
  const { customer, license, activation, policy, at } = input;
  const key = services.control?.signingKeyPem;
  if (!key) throw new Error('Control plane signing key is not configured');
  const end = licenseEnd(license.expiresAt);
  const window = policy.offlineEnabled
    ? Math.max(policy.maxOfflineMinutes, 0) * 60_000
    : timing.onlineOnlyGrantMs;
  const expiresAt = new Date(Math.min(at.getTime() + window, end.getTime()));
  const grant: Grant = {
    t: 'grant',
    v: 1,
    customerId: customer.id,
    customerName: customer.name,
    licenseId: license.id,
    activationId: activation.id,
    fingerprint: fingerprintOf(activation.publicKey),
    issuedAt: at.toISOString(),
    expiresAt: expiresAt.toISOString(),
    licenseExpiresAt: end.toISOString(),
    status: grantStatusOf(customer, license, activation),
    features: license.features.filter((feature) =>
      (planFeatures as readonly string[]).includes(feature),
    ),
    limits: {
      branches: license.maxBranches,
      users: license.maxUsers,
      devices: license.maxDevices,
    },
    policy,
  };
  return { document: signDocument(key, grant), grant };
}
