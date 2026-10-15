import { catalogByKey, type FeatureDef } from './catalog.js';

// Policy: what SUPER_OWNER decided for one customer. It is stored centrally, carried
// inside the signed grant and evaluated by the backend of the install (or of the
// cloud server) on every request.

export type FeatureMode = 'ON' | 'OFF' | 'ADMIN';

export type FeatureOverride = {
  // ON/OFF are final. ADMIN delegates the decision to the restaurant's Admin.
  mode?: FeatureMode;
  online?: boolean;
  offline?: boolean;
};

export type PolicyDoc = {
  version: number;
  features: Record<string, FeatureOverride>;
  offlineEnabled: boolean;
  maxOfflineMinutes: number;
  minAppVersion: string | null;
  // Installs older than minAppVersion stop taking NEW orders only after this moment,
  // so an update never interrupts a sale in progress.
  minVersionFrom: string | null;
};

export const defaultPolicy = (): PolicyDoc => ({
  version: 0,
  features: {},
  offlineEnabled: false,
  maxOfflineMinutes: 0,
  minAppVersion: null,
  minVersionFrom: null,
});

/** Restaurant Admin settings for delegated features: `${key}|${roleKey}` -> enabled. */
export type AdminSettings = Map<string, boolean>;

export type Evaluation = {
  // Stored mode of the feature in this policy (catalog default when unset).
  mode: FeatureMode;
  online: boolean;
  offline: boolean;
};

export function featureMode(policy: PolicyDoc, def: FeatureDef): FeatureMode {
  return policy.features[def.key]?.mode ?? def.defaultMode ?? 'ON';
}

/**
 * Evaluates one feature for a user holding `roleKeys`. SUPER_OWNER's OFF always wins;
 * ADMIN defers to the restaurant Admin's setting (catalog default when none was made).
 */
export function evaluateFeature(
  policy: PolicyDoc,
  def: FeatureDef,
  roleKeys: readonly string[] = [],
  adminSettings: AdminSettings = new Map(),
): Evaluation {
  const override = policy.features[def.key];
  const mode = featureMode(policy, def);
  let enabled = mode !== 'OFF';
  if (mode === 'ADMIN') {
    const explicit = [...roleKeys, '*']
      .map((role) => adminSettings.get(`${def.key}|${role}`))
      .filter((value): value is boolean => value !== undefined);
    // A delegated feature follows the catalog default until the Admin decides.
    enabled = explicit.length
      ? explicit.some(Boolean)
      : def.defaultMode !== 'OFF';
  }
  const online = enabled && (override?.online ?? true);
  const offline =
    enabled && def.offlineCapable && (override?.offline ?? def.defaultOffline);
  return { mode, online, offline };
}

export function evaluateKey(
  policy: PolicyDoc,
  key: string,
  roleKeys: readonly string[] = [],
  adminSettings: AdminSettings = new Map(),
): Evaluation | null {
  const def = catalogByKey.get(key);
  return def ? evaluateFeature(policy, def, roleKeys, adminSettings) : null;
}

/** Roles that count as the Cashier panel's users for cost/margin/profit hiding. */
export function isCashierClass(
  roleKeys: readonly string[],
  hasPosAccess: boolean,
): boolean {
  if (roleKeys.includes('owner') || roleKeys.includes('admin')) return false;
  return roleKeys.includes('cashier') || hasPosAccess;
}

export type FinancialVisibility = {
  cost: boolean;
  margin: boolean;
  profit: boolean;
};

/**
 * Cost price, margin and net profit visibility. Cashier-class users see none of them
 * unless SUPER_OWNER switched the matching `fin.cashier.*` feature on (or delegated it
 * to the Admin, who then enabled it). Role permissions still apply on top of this.
 */
export function financialVisibility(
  policy: PolicyDoc,
  roleKeys: readonly string[],
  hasPosAccess: boolean,
  adminSettings: AdminSettings = new Map(),
): FinancialVisibility {
  const cashier = isCashierClass(roleKeys, hasPosAccess);
  const on = (key: string) =>
    evaluateKey(policy, key, roleKeys, adminSettings)?.online ?? false;
  const flags = (global: string, role: string) =>
    on(global) && (!cashier || on(role));
  return {
    cost: flags('fin.cost', 'fin.cashier.cost'),
    margin: flags('fin.margin', 'fin.cashier.margin'),
    profit: flags('fin.profit', 'fin.cashier.profit'),
  };
}

/** Sidebar paths of panels SUPER_OWNER switched off completely. */
export function hiddenMenuPaths(policy: PolicyDoc): string[] {
  const paths: string[] = [];
  for (const [key, override] of Object.entries(policy.features)) {
    const def = catalogByKey.get(key);
    if (def?.menuPath && override.mode === 'OFF') paths.push(def.menuPath);
  }
  return paths;
}

/** Keeps only valid keys and values so a stored policy can never poison evaluation. */
export function sanitizeFeatures(
  input: unknown,
): Record<string, FeatureOverride> {
  const result: Record<string, FeatureOverride> = {};
  if (typeof input !== 'object' || input === null) return result;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!catalogByKey.has(key) || typeof raw !== 'object' || raw === null)
      continue;
    const value = raw as Record<string, unknown>;
    const entry: FeatureOverride = {};
    if (value.mode === 'ON' || value.mode === 'OFF' || value.mode === 'ADMIN')
      entry.mode = value.mode;
    if (typeof value.online === 'boolean') entry.online = value.online;
    if (typeof value.offline === 'boolean') entry.offline = value.offline;
    if (Object.keys(entry).length) result[key] = entry;
  }
  return result;
}
