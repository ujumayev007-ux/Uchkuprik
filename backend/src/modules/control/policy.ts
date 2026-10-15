import {
  catalogByKey,
  type FeatureDef,
  type ParamDef,
  type ParamValue,
} from './catalog.js';

// Policy: what SUPER_OWNER decided for one customer. It is stored centrally, carried
// inside the signed grant and evaluated by the backend of the install (or of the
// cloud server) on every request.

export type FeatureMode = 'ON' | 'OFF' | 'ADMIN';

export type ParamValues = Record<string, ParamValue>;

export type RoleOverride = {
  // Explicit decision for users holding this role. false removes the feature for
  // them even where it is on for others; true switches it on for them even where
  // the Admin has not enabled a delegated feature. A global OFF is still final.
  enabled?: boolean;
  params?: ParamValues;
};

export type FeatureOverride = {
  // ON/OFF are final. ADMIN delegates the decision to the restaurant's Admin.
  mode?: FeatureMode;
  online?: boolean;
  offline?: boolean;
  // Values for every role unless a role override says otherwise.
  params?: ParamValues;
  roles?: Record<string, RoleOverride>;
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
/** Restaurant Admin values for delegated parameters: `${key}|${roleKey}` -> values. */
export type AdminParams = Map<string, ParamValues>;

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
 * A role override applies per role and the user keeps what any of their roles allows.
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
  if (mode !== 'OFF' && override?.roles && roleKeys.length > 0) {
    const base = enabled;
    enabled = roleKeys
      .map((role) => override.roles?.[role]?.enabled ?? base)
      .some(Boolean);
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

/** Whether SUPER_OWNER explicitly switched the feature on for one of these roles. */
export function explicitRoleOn(
  policy: PolicyDoc,
  key: string,
  roleKeys: readonly string[],
): boolean {
  const override = policy.features[key];
  return (
    override?.mode !== 'OFF' &&
    roleKeys.some((role) => override?.roles?.[role]?.enabled === true)
  );
}

function coerceParam(def: ParamDef, value: unknown): ParamValue | undefined {
  if (def.type === 'int')
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= def.min &&
      value <= def.max
      ? value
      : undefined;
  if (def.type === 'bool')
    return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'string' &&
    def.options.some((option) => option.value === value)
    ? value
    : undefined;
}

/** Several roles at once: numbers take the most permissive (largest) value. */
function mergeRoleValues(def: ParamDef, values: ParamValue[]) {
  if (values.length === 0) return undefined;
  if (def.type === 'int') return Math.max(...(values as number[]));
  if (def.type === 'bool') return values.some(Boolean);
  return values[0];
}

/**
 * Resolves the parameter values of a feature for one user: catalog default, then the
 * restaurant-wide SUPER_OWNER value, then the user's role values. Values the Admin set
 * for a delegated feature replace them, but numbers marked `ownerCap` never exceed
 * what SUPER_OWNER allows.
 */
export function resolveParams(
  policy: PolicyDoc,
  def: FeatureDef,
  roleKeys: readonly string[] = [],
  adminParams: AdminParams = new Map(),
): Record<string, ParamValue> {
  const override = policy.features[def.key];
  const mode = featureMode(policy, def);
  const result: Record<string, ParamValue> = {};
  for (const param of def.params ?? []) {
    const roleValues = roleKeys
      .map((role) =>
        coerceParam(param, override?.roles?.[role]?.params?.[param.key]),
      )
      .filter((value): value is ParamValue => value !== undefined);
    const owner =
      mergeRoleValues(param, roleValues) ??
      coerceParam(param, override?.params?.[param.key]) ??
      param.default;
    let value: ParamValue = owner;
    if (mode === 'ADMIN') {
      const specific = roleKeys
        .map((role) =>
          coerceParam(
            param,
            adminParams.get(`${def.key}|${role}`)?.[param.key],
          ),
        )
        .filter((item): item is ParamValue => item !== undefined);
      const admin =
        mergeRoleValues(param, specific) ??
        coerceParam(param, adminParams.get(`${def.key}|*`)?.[param.key]);
      if (admin !== undefined) value = admin;
      if (
        param.type === 'int' &&
        param.ownerCap &&
        typeof value === 'number' &&
        typeof owner === 'number'
      )
        value = Math.min(value, owner);
    }
    result[param.key] = value;
  }
  return result;
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

const ROLE_KEY = /^[a-z0-9_-]{1,40}$/;

/** Keeps only values valid for the feature's parameter definitions. */
export function sanitizeParams(
  def: FeatureDef,
  input: unknown,
  keepDefaults = false,
): ParamValues | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const source = input as Record<string, unknown>;
  const result: ParamValues = {};
  for (const param of def.params ?? []) {
    const value = coerceParam(param, source[param.key]);
    if (value !== undefined && (keepDefaults || value !== param.default))
      result[param.key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Keeps only valid keys and values so a stored policy can never poison evaluation. */
export function sanitizeFeatures(
  input: unknown,
): Record<string, FeatureOverride> {
  const result: Record<string, FeatureOverride> = {};
  if (typeof input !== 'object' || input === null) return result;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = catalogByKey.get(key);
    if (!def || typeof raw !== 'object' || raw === null) continue;
    const value = raw as Record<string, unknown>;
    const entry: FeatureOverride = {};
    if (value.mode === 'ON' || value.mode === 'OFF' || value.mode === 'ADMIN')
      entry.mode = value.mode;
    if (typeof value.online === 'boolean') entry.online = value.online;
    if (typeof value.offline === 'boolean') entry.offline = value.offline;
    const params = sanitizeParams(def, value.params);
    if (params) entry.params = params;
    if (typeof value.roles === 'object' && value.roles !== null) {
      const roles: Record<string, RoleOverride> = {};
      for (const [role, rawRole] of Object.entries(
        value.roles as Record<string, unknown>,
      ).slice(0, 30)) {
        if (!ROLE_KEY.test(role) || typeof rawRole !== 'object' || !rawRole)
          continue;
        const roleValue = rawRole as Record<string, unknown>;
        const roleEntry: RoleOverride = {};
        if (typeof roleValue.enabled === 'boolean')
          roleEntry.enabled = roleValue.enabled;
        // Role values stay even when equal to the default: they must be able to
        // override a non-default restaurant-wide value.
        const roleParams = sanitizeParams(def, roleValue.params, true);
        if (roleParams) roleEntry.params = roleParams;
        if (Object.keys(roleEntry).length) roles[role] = roleEntry;
      }
      if (Object.keys(roles).length) entry.roles = roles;
    }
    if (Object.keys(entry).length) result[key] = entry;
  }
  return result;
}
