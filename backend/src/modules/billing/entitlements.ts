import type { NextFunction, Request, Response } from 'express';
import type { Tx } from '../../db.js';
import { AppError } from '../../http/errors.js';
import type { AuthContext } from '../auth/session.js';

/** Plan features that unlock optional modules. Core POS, menu, orders and reports are in every plan. */
export const planFeatures = [
  'inventory',
  'delivery',
  'online_ordering',
  'loyalty',
  'kitchen_printing',
  'online_payments',
  'hr',
  'finance',
  'multi_brand',
  'franchise',
  'operations',
  'developer_api',
] as const;
export type PlanFeature = (typeof planFeatures)[number];

export type Entitlements = {
  planCode: string | null;
  status: string | null;
  // Null means unrestricted (tenants provisioned before plans existed).
  features: PlanFeature[] | null;
  limits: {
    branches: number | null;
    users: number | null;
    devices: number | null;
  };
};

type SubscriptionWithPlan = {
  status: string;
  plan: {
    code: string;
    features: string[];
    maxBranches: number | null;
    maxUsers: number | null;
    maxDevices: number | null;
  };
} | null;

export function entitlementsOf(
  subscription: SubscriptionWithPlan,
): Entitlements {
  if (!subscription)
    return {
      planCode: null,
      status: null,
      features: null,
      limits: { branches: null, users: null, devices: null },
    };
  const { plan } = subscription;
  return {
    planCode: plan.code,
    status: subscription.status,
    features: plan.features.filter((key): key is PlanFeature =>
      (planFeatures as readonly string[]).includes(key),
    ),
    limits: {
      branches: plan.maxBranches,
      users: plan.maxUsers,
      devices: plan.maxDevices,
    },
  };
}

export function hasFeature(auth: AuthContext, feature: PlanFeature) {
  return (
    auth.entitlements.features === null ||
    auth.entitlements.features.includes(feature)
  );
}

// API paths (relative to /api) that belong to optional modules. Matching is by path
// segment prefix so new endpoints inside a module are gated automatically.
const gatedPaths: [RegExp, PlanFeature][] = [
  [/^\/(inventory|purchases|recipes|suppliers)(\/|$)/, 'inventory'],
  [/^\/(delivery|courier)(\/|$)/, 'delivery'],
  [/^\/orders\/[^/]+\/delivery-zone$/, 'delivery'],
  [/^\/orders\/[^/]+\/(approve|reject)$/, 'online_ordering'],
  [/^\/(coupons)(\/|$)/, 'loyalty'],
  [/^\/customers\/[^/]+\/points$/, 'loyalty'],
  [/^\/orders\/[^/]+\/coupon$/, 'loyalty'],
  [/^\/(printers|print-jobs)(\/|$)/, 'kitchen_printing'],
  [/^\/payments\/(providers|reconciliation)(\/|$)/, 'online_payments'],
  [/^\/(hr|payroll|schedule)(\/|$)/, 'hr'],
  [/^\/(expenses|finance)(\/|$)/, 'finance'],
  [/^\/reports\/pnl(\.csv)?$/, 'finance'],
  [/^\/brands(\/|$)/, 'multi_brand'],
  [/^\/reports\/brands$/, 'multi_brand'],
  [/^\/(franchise|supplier-agreements)(\/|$)/, 'franchise'],
  [/^\/operations(\/|$)/, 'operations'],
  [/^\/developer(\/|$)/, 'developer_api'],
  [
    /^\/(assets|repair-tickets|maintenance-plans|service-contracts|training|approvals)(\/|$)/,
    'operations',
  ],
];

export function featureForPath(path: string): PlanFeature | null {
  for (const [pattern, feature] of gatedPaths)
    if (pattern.test(path)) return feature;
  return null;
}

/** Rejects requests to modules that the tenant's plan does not include. */
export function enforcePlanFeatures() {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (auth?.tenantKind === 'BUSINESS') {
      const feature = featureForPath(req.path);
      if (feature && !hasFeature(auth, feature))
        throw new AppError(403, 'FEATURE_NOT_IN_PLAN', 'featureNotInPlan', {
          feature,
        });
    }
    next();
  };
}

export async function tenantEntitlements(tx: Tx, tenantId: string) {
  const subscription = await tx.subscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
  return entitlementsOf(subscription);
}

export type LimitKind = 'branches' | 'users' | 'devices';

export async function countUsage(tx: Tx, tenantId: string) {
  const [branches, users, devices] = await Promise.all([
    tx.branch.count({ where: { tenantId, isActive: true, deletedAt: null } }),
    tx.user.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE' } }),
    tx.device.count({ where: { tenantId, status: 'ACTIVE' } }),
  ]);
  return { branches, users, devices };
}

/**
 * Throws when adding one more resource would exceed the plan limit. Call inside the
 * creating transaction after locking the tenant row so concurrent creations serialize.
 */
export async function assertWithinLimit(
  tx: Tx,
  tenantId: string,
  kind: LimitKind,
) {
  const { limits } = await tenantEntitlements(tx, tenantId);
  const limit = limits[kind];
  if (limit === null) return;
  await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;
  const usage = await countUsage(tx, tenantId);
  if (usage[kind] >= limit)
    throw new AppError(403, 'PLAN_LIMIT_REACHED', 'planLimitReached', {
      limit: kind,
      max: limit,
    });
}
