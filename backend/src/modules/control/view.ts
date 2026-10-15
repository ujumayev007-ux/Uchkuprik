import type { Db } from '../../db.js';
import type { ControlMode, ControlReason } from './grant.js';
import {
  defaultPolicy,
  sanitizeFeatures,
  type AdminSettings,
  type PolicyDoc,
} from './policy.js';

/** What the rest of the backend needs to know about control for one tenant. */
export type ControlView = {
  mode: ControlMode;
  reason: ControlReason | null;
  policy: PolicyDoc;
  // Restaurant Admin decisions for features SUPER_OWNER delegated.
  adminSettings: AdminSettings;
  offlineUntil: Date | null;
  // This install runs an older version than the policy requires.
  versionBlocked: boolean;
};

export const unlinkedView = (): ControlView => ({
  mode: 'UNLINKED',
  reason: null,
  policy: defaultPolicy(),
  adminSettings: new Map(),
  offlineUntil: null,
  versionBlocked: false,
});

export type ControlViewProvider = (
  tenantId: string | null,
) => Promise<ControlView>;

const SETTINGS_TTL_MS = 10_000;
const settingsCache = new Map<string, { at: number; value: AdminSettings }>();

export function clearAdminSettingsCache() {
  settingsCache.clear();
}

/** Admin switches of one tenant (cached briefly; writes clear the cache). */
export async function loadAdminSettings(
  db: Db,
  tenantId: string,
  nowMs = Date.now(),
): Promise<AdminSettings> {
  const hit = settingsCache.get(tenantId);
  if (hit && nowMs - hit.at < SETTINGS_TTL_MS) return hit.value;
  const rows = await db.featureSetting.findMany({ where: { tenantId } });
  const value: AdminSettings = new Map(
    rows.map((row) => [`${row.featureKey}|${row.roleKey}`, row.enabled]),
  );
  settingsCache.set(tenantId, { at: nowMs, value });
  return value;
}

const POLICY_TTL_MS = 15_000;
const policyCache = new Map<string, { at: number; value: PolicyDoc | null }>();

export function clearPolicyCache() {
  policyCache.clear();
}

/**
 * Cloud edition: the policy of a hosted tenant comes straight from the control
 * tables (the tenant is linked to a customer). Hosted tenants have no offline mode.
 */
export function cloudViewProvider(
  db: Db,
  now: () => Date,
): ControlViewProvider {
  return async (tenantId) => {
    if (!tenantId) return unlinkedView();
    const at = now().getTime();
    let policy: PolicyDoc | null;
    const hit = policyCache.get(tenantId);
    if (hit && at - hit.at < POLICY_TTL_MS) policy = hit.value;
    else {
      const customer = await db.controlCustomer.findUnique({
        where: { tenantId },
        include: { policy: true },
      });
      policy = customer
        ? {
            ...defaultPolicy(),
            ...(customer.policy
              ? {
                  version: customer.policy.version,
                  features: sanitizeFeatures(customer.policy.features),
                  minAppVersion: customer.policy.minAppVersion,
                }
              : {}),
          }
        : null;
      policyCache.set(tenantId, { at, value: policy });
    }
    if (!policy) return unlinkedView();
    return {
      mode: 'ONLINE',
      reason: null,
      policy,
      adminSettings: await loadAdminSettings(db, tenantId, at),
      offlineUntil: null,
      versionBlocked: false,
    };
  };
}
