import type { Db } from '../../db.js';
import type { ControlMode, ControlReason } from './grant.js';
import {
  defaultPolicy,
  sanitizeFeatures,
  type AdminParams,
  type AdminSettings,
  type ParamValues,
  type PolicyDoc,
} from './policy.js';

/** What the rest of the backend needs to know about control for one tenant. */
export type ControlView = {
  mode: ControlMode;
  reason: ControlReason | null;
  policy: PolicyDoc;
  // Restaurant Admin decisions for features SUPER_OWNER delegated.
  adminSettings: AdminSettings;
  // Values the Admin set for delegated parameters (limits, defaults).
  adminParams: AdminParams;
  offlineUntil: Date | null;
  // This install runs an older version than the policy requires.
  versionBlocked: boolean;
};

export const unlinkedView = (): ControlView => ({
  mode: 'UNLINKED',
  reason: null,
  policy: defaultPolicy(),
  adminSettings: new Map(),
  adminParams: new Map(),
  offlineUntil: null,
  versionBlocked: false,
});

export type ControlViewProvider = (
  tenantId: string | null,
) => Promise<ControlView>;

const SETTINGS_TTL_MS = 10_000;
type AdminData = { settings: AdminSettings; params: AdminParams };
const settingsCache = new Map<string, { at: number; value: AdminData }>();

export function clearAdminSettingsCache() {
  settingsCache.clear();
}

/** Admin switches and values of one tenant (cached briefly; writes clear the cache). */
export async function loadAdminData(
  db: Db,
  tenantId: string,
  nowMs = Date.now(),
): Promise<AdminData> {
  const hit = settingsCache.get(tenantId);
  if (hit && nowMs - hit.at < SETTINGS_TTL_MS) return hit.value;
  const rows = await db.featureSetting.findMany({ where: { tenantId } });
  const settings: AdminSettings = new Map();
  const params: AdminParams = new Map();
  for (const row of rows) {
    const composite = `${row.featureKey}|${row.roleKey}`;
    if (row.enabled !== null) settings.set(composite, row.enabled);
    if (row.params && typeof row.params === 'object')
      params.set(composite, row.params as ParamValues);
  }
  const value = { settings, params };
  settingsCache.set(tenantId, { at: nowMs, value });
  return value;
}

export async function loadAdminSettings(
  db: Db,
  tenantId: string,
  nowMs = Date.now(),
): Promise<AdminSettings> {
  return (await loadAdminData(db, tenantId, nowMs)).settings;
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
    const admin = await loadAdminData(db, tenantId, at);
    return {
      mode: 'ONLINE',
      reason: null,
      policy,
      adminSettings: admin.settings,
      adminParams: admin.params,
      offlineUntil: null,
      versionBlocked: false,
    };
  };
}
