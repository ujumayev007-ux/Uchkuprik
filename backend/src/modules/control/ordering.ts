import { catalogByKey } from './catalog.js';
import {
  evaluateFeature,
  explicitRoleOn,
  resolveParams,
  type AdminParams,
  type AdminSettings,
  type PolicyDoc,
} from './policy.js';

// Ordering experience decided centrally: which order types and buttons a user has,
// discount limits, order display modes, the customer TV and the waiter alerts. Built
// from the same policy as every other feature (switches per role, delegated to the
// Admin where SUPER_OWNER chose so) and enforced by the order routes.

export type OrderDisplayMode = 'compact' | 'detailed' | 'grid';

export type OrderingConfig = {
  types: { DINE_IN: boolean; TAKEAWAY: boolean; DELIVERY: boolean };
  // «Mijoz»: an order without a table, assigned a table after the guest sits down.
  walkin: boolean;
  tableAssign: boolean;
  discount: {
    percent: boolean;
    fixed: boolean;
    maxPercentBp: number;
    maxFixed: number;
  };
  display: { mode: OrderDisplayMode; canChange: boolean };
  tv: {
    enabled: boolean;
    layout: 'split' | 'single';
    showPreparing: boolean;
    showReady: boolean;
    voice: {
      enabled: boolean;
      repeat: number;
      volume: number;
      phrase: 'ordinal' | 'cardinal';
    };
  };
  waiterAlerts: {
    enabled: boolean;
    sound: boolean;
    voice: boolean;
    volume: number;
    repeat: number;
    reminderSeconds: number;
  };
};

type Input = {
  policy: PolicyDoc;
  adminSettings: AdminSettings;
  adminParams: AdminParams;
  roleKeys: readonly string[];
  // Offline grants are evaluated with the separate offline permissions.
  offline: boolean;
};

export function buildOrdering(input: Input): OrderingConfig {
  const { policy, adminSettings, adminParams, roleKeys, offline } = input;
  const on = (key: string) => {
    const def = catalogByKey.get(key);
    if (!def) return true;
    const result = evaluateFeature(policy, def, roleKeys, adminSettings);
    return offline ? result.offline : result.online;
  };
  const params = (key: string) => {
    const def = catalogByKey.get(key);
    return def ? resolveParams(policy, def, roleKeys, adminParams) : {};
  };
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' ? value : fallback;
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;

  const percent = params('discounts.percent');
  const fixed = params('discounts.fixed');
  const display = params('orders.display');
  const tv = params('tv.display');
  const voice = params('tv.voice');
  const alerts = params('waiter.notify');

  // Waiters are the audience of «new guest» alerts; other roles only when SUPER_OWNER
  // explicitly switched the alert on for them.
  const alertsOn =
    on('waiter.notify') &&
    on('orders.table.assign') &&
    (roleKeys.includes('waiter') ||
      explicitRoleOn(policy, 'waiter.notify', roleKeys));

  return {
    types: {
      DINE_IN: on('orders.type.dine_in'),
      TAKEAWAY: on('orders.type.takeaway'),
      DELIVERY: on('orders.type.delivery'),
    },
    walkin: on('orders.walkin'),
    tableAssign: on('orders.table.assign'),
    discount: {
      percent: on('discounts.percent'),
      fixed: on('discounts.fixed'),
      maxPercentBp: Math.round(num(percent.maxPercent, 100) * 100),
      maxFixed: num(fixed.maxFixed, 100_000_000),
    },
    display: {
      mode:
        display.defaultMode === 'compact' || display.defaultMode === 'grid'
          ? display.defaultMode
          : 'detailed',
      canChange: on('orders.display'),
    },
    tv: {
      enabled: on('tv.display'),
      layout: tv.layout === 'single' ? 'single' : 'split',
      showPreparing: bool(tv.showPreparing, true),
      showReady: bool(tv.showReady, true),
      voice: {
        enabled: on('tv.voice'),
        repeat: num(voice.repeat, 1),
        volume: num(voice.volume, 100),
        phrase: voice.phrase === 'cardinal' ? 'cardinal' : 'ordinal',
      },
    },
    waiterAlerts: {
      enabled: alertsOn,
      sound: bool(alerts.sound, true),
      voice: bool(alerts.voice, true),
      volume: num(alerts.volume, 100),
      repeat: num(alerts.repeat, 1),
      reminderSeconds: num(alerts.reminderSeconds, 0),
    },
  };
}

/** Everything allowed, nothing limited: what installs without central control get. */
export function defaultOrdering(): OrderingConfig {
  return buildOrdering({
    policy: {
      version: 0,
      features: {},
      offlineEnabled: false,
      maxOfflineMinutes: 0,
      minAppVersion: null,
      minVersionFrom: null,
    },
    adminSettings: new Map(),
    adminParams: new Map(),
    roleKeys: [],
    offline: false,
  });
}
