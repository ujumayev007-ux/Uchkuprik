import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { messages } from '../../messages.js';
import { audit } from '../audit/audit.js';
import { passwordSchema } from '../auth/auth.routes.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requirePlatformAdmin,
  requireRecentAuth,
} from '../auth/session.js';
import {
  createBusinessTenant,
  PLATFORM_SLUG,
} from '../tenants/provisioning.js';
import { countUsage, planFeatures } from './entitlements.js';
import {
  addCycle,
  INVOICE_DUE_DAYS,
  markInvoicePaid,
  monthlyValue,
  priceFor,
  runBillingCycle,
  startTrial,
} from './lifecycle.js';

const DAY = 86_400_000;

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
  .refine((slug) => slug !== PLATFORM_SLUG);
const cycleSchema = z.enum(['MONTHLY', 'YEARLY']);
const planCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,20}$/);

function requireOwner() {
  return (_req: unknown, res: Response, next: () => void) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS' || !auth.roleKeys.includes('owner'))
      throw errors.forbidden();
    next();
  };
}

function planView(plan: {
  id: string;
  code: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
  features: string[];
  trialDays: number;
  isActive: boolean;
}) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    monthlyPrice: plan.monthlyPrice,
    yearlyPrice: plan.yearlyPrice,
    maxBranches: plan.maxBranches,
    maxUsers: plan.maxUsers,
    maxDevices: plan.maxDevices,
    features: plan.features,
    trialDays: plan.trialDays,
    isActive: plan.isActive,
  };
}

function invoiceView(invoice: {
  id: string;
  number: bigint;
  planCode: string;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  status: string;
  dueDate: Date;
  paidAt: Date | null;
  reference: string | null;
}) {
  return {
    id: invoice.id,
    number: `INV-${invoice.number.toString().padStart(6, '0')}`,
    planCode: invoice.planCode,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    amount: invoice.amount,
    status: invoice.status,
    dueDate: invoice.dueDate,
    paidAt: invoice.paidAt,
    reference: invoice.reference,
  };
}

// Tenant data export: every tenant-scoped table, minus credentials and transient
// queues. Hashes, encrypted secrets and access tokens are never exported.
const exportModels: { model: string; omit?: Record<string, true> }[] = [
  { model: 'tenantProfile' },
  { model: 'branch' },
  {
    model: 'user',
    omit: { passwordHash: true, pinHash: true, mfaSecretEnc: true },
  },
  { model: 'role' },
  { model: 'userRole' },
  { model: 'userBranch' },
  { model: 'device', omit: { tokenHash: true } },
  { model: 'room' },
  { model: 'diningTable', omit: { qrToken: true } },
  { model: 'menuCategory' },
  { model: 'product' },
  { model: 'productVariant' },
  { model: 'branchVariantPrice' },
  { model: 'modifierGroup' },
  { model: 'modifierOption' },
  { model: 'productModifierGroup' },
  { model: 'cashShift' },
  { model: 'cashMovement' },
  { model: 'order', omit: { trackingToken: true } },
  { model: 'orderItem' },
  { model: 'orderEvent' },
  { model: 'payment' },
  { model: 'refund' },
  { model: 'kitchenStation' },
  { model: 'printer' },
  { model: 'stockItem' },
  { model: 'stockUnit' },
  { model: 'warehouse' },
  { model: 'stockBalance' },
  { model: 'stockMovement' },
  { model: 'supplier' },
  { model: 'purchase' },
  { model: 'purchaseLine' },
  { model: 'supplierPayment' },
  { model: 'recipeLine' },
  { model: 'fiscalReceipt' },
  { model: 'customer' },
  { model: 'loyaltyEntry' },
  { model: 'coupon' },
  { model: 'feedback' },
  { model: 'deliveryZone' },
  { model: 'courierProfile' },
  { model: 'employeeProfile' },
  { model: 'attendanceRecord' },
  { model: 'scheduledShift' },
  { model: 'payrollPeriod' },
  { model: 'payrollLine' },
  { model: 'payrollAdjustment' },
  { model: 'expense' },
  { model: 'closedPeriod' },
  { model: 'invoice' },
  { model: 'auditLog' },
];

type Delegate = {
  findMany: (args: object) => Promise<{ id?: unknown }[]>;
};

const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

const PAGE = 1000;
const unpaged = new Set([
  'tenantProfile',
  'userRole',
  'userBranch',
  'branchVariantPrice',
  'productModifierGroup',
  'stockBalance',
  'courierProfile',
  'employeeProfile',
  'closedPeriod',
]);

async function streamExport(db: Db, tenantId: string, res: Response) {
  res.write('{"format":"fastfood-export","version":1');
  for (const { model, omit } of exportModels) {
    const delegate = (db as unknown as Record<string, Delegate>)[model]!;
    res.write(`,${JSON.stringify(model)}:[`);
    let first = true;
    let cursor: unknown = undefined;
    // Tables with an id are paged by id; join tables are small and read at once.
    const paged = !unpaged.has(model);
    for (;;) {
      const rows = await delegate.findMany({
        where: { tenantId },
        ...(omit ? { omit } : {}),
        ...(paged
          ? {
              orderBy: { id: 'asc' },
              take: PAGE,
              ...(cursor === undefined
                ? {}
                : { cursor: { id: cursor }, skip: 1 }),
            }
          : {}),
      });
      for (const row of rows) {
        res.write((first ? '' : ',') + JSON.stringify(row, jsonReplacer));
        first = false;
      }
      if (!paged || rows.length < PAGE) break;
      cursor = rows[rows.length - 1]!.id;
    }
    res.write(']');
  }
  res.end('}');
}

export function billingRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const admin = [requireAuth(), requirePlatformAdmin()];
  const signupLimit = services.limits?.signupsPerHour ?? 5;
  const signupLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: Math.max(signupLimit, 1),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });

  // ---------------------------------------------------------------- public

  router.get('/public/plans', async (_req, res) => {
    const plans = await db.plan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    res.json({ plans: plans.map(planView), signupEnabled: signupLimit > 0 });
  });

  router.post('/public/register', signupLimiter, async (req, res) => {
    if (signupLimit === 0)
      throw new AppError(403, 'SIGNUP_DISABLED', 'signupDisabled');
    const input = parse(
      z.object({
        businessName: z.string().trim().min(2).max(100),
        slug: slugSchema,
        branchName: z.string().trim().min(2).max(80),
        ownerName: z.string().trim().min(2).max(80),
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9._-]{3,40}$/),
        password: z.string(),
        planCode: planCodeSchema,
        acceptTerms: z.literal(true),
      }),
      req.body,
    );
    if (!passwordSchema.safeParse(input.password).success)
      throw new AppError(400, 'WEAK_PASSWORD', 'weakPassword');
    try {
      const created = await db.$transaction(async (tx) => {
        const result = await createBusinessTenant(tx, {
          slug: input.slug,
          name: input.businessName,
          branchName: input.branchName,
          owner: {
            username: input.username,
            displayName: input.ownerName,
            password: input.password,
          },
          ownerChosePassword: true,
        });
        // Self-hosted installs (desktop) have no SaaS plans: the business is unrestricted.
        if (!services.selfHosted) {
          const subscription = await startTrial(
            tx,
            result.tenant.id,
            input.planCode,
            now(),
          );
          if (!subscription) throw errors.validation([{ path: 'planCode' }]);
        }
        await audit(tx, req, {
          tenantId: result.tenant.id,
          actorUserId: result.owner.id,
          action: 'tenant.register',
          entityType: 'tenant',
          entityId: result.tenant.id,
          data: { planCode: input.planCode },
        });
        return result;
      });
      res.status(201).json({ slug: created.tenant.slug });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // ---------------------------------------------------------------- tenant

  router.get(
    '/billing',
    requireAuth(),
    requirePermission('settings.manage'),
    async (_req, res) => {
      const auth = getAuth(res);
      const [subscription, usage, plans, invoices] = await Promise.all([
        db.subscription.findUnique({
          where: { tenantId: auth.tenantId },
          include: { plan: true },
        }),
        countUsage(db, auth.tenantId),
        db.plan.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        }),
        db.invoice.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: { periodStart: 'desc' },
          take: 24,
        }),
      ]);
      res.json({
        subscription: subscription && {
          status: subscription.status,
          billingCycle: subscription.billingCycle,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          plan: planView(subscription.plan),
        },
        usage,
        isOwner: auth.roleKeys.includes('owner'),
        plans: plans.map(planView),
        invoices: invoices.map(invoiceView),
        features: planFeatures,
      });
    },
  );

  router.post(
    '/billing/plan',
    requireAuth(),
    requireOwner(),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z.object({ planCode: planCodeSchema, billingCycle: cycleSchema }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const plan = await tx.plan.findFirst({
          where: { code: input.planCode, isActive: true },
        });
        if (!plan) throw errors.validation([{ path: 'planCode' }]);
        const usage = await countUsage(tx, auth.tenantId);
        if (
          (plan.maxBranches !== null && usage.branches > plan.maxBranches) ||
          (plan.maxUsers !== null && usage.users > plan.maxUsers) ||
          (plan.maxDevices !== null && usage.devices > plan.maxDevices)
        )
          throw new AppError(409, 'PLAN_USAGE_EXCEEDS', 'planUsageExceeds', {
            usage,
          });
        await changePlan(tx, auth.tenantId, plan, input.billingCycle, now());
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'billing.plan.change',
          entityType: 'tenant',
          entityId: auth.tenantId,
          data: { planCode: plan.code, billingCycle: input.billingCycle },
        });
      });
      res.json({ ok: true });
    },
  );

  router.get(
    '/tenant/export',
    requireAuth(),
    requireOwner(),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'tenant.export',
        entityType: 'tenant',
        entityId: auth.tenantId,
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="fastfood-export-${now().toISOString().slice(0, 10)}.json"`,
      );
      await streamExport(db, auth.tenantId, res);
    },
  );

  router.post(
    '/tenant/close',
    requireAuth(),
    requireOwner(),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const { confirm } = parse(
        z.object({ confirm: z.string().trim().max(60) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: auth.tenantId },
        });
        if (confirm !== tenant.slug)
          throw new AppError(400, 'CONFIRM_MISMATCH', 'confirmMismatch');
        const at = now();
        await tx.tenant.update({
          where: { id: tenant.id },
          data: { status: 'CLOSED', closedAt: at },
        });
        await tx.subscription.updateMany({
          where: { tenantId: tenant.id },
          data: { status: 'CANCELLED' },
        });
        // Invoices for periods that have not started are no longer owed.
        await tx.invoice.updateMany({
          where: {
            tenantId: tenant.id,
            status: 'OPEN',
            periodStart: { gt: at },
          },
          data: { status: 'VOID' },
        });
        await tx.session.updateMany({
          where: { tenantId: tenant.id, revokedAt: null },
          data: { revokedAt: at, revokeReason: 'tenant_closed' },
        });
        await audit(tx, req, {
          tenantId: tenant.id,
          actorUserId: auth.userId,
          action: 'tenant.close',
          entityType: 'tenant',
          entityId: tenant.id,
        });
      });
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------- platform

  const planInput = z.object({
    code: planCodeSchema,
    name: z.string().trim().min(2).max(60),
    monthlyPrice: z.number().int().min(0).max(1_000_000_000),
    yearlyPrice: z.number().int().min(0).max(2_000_000_000),
    maxBranches: z.number().int().min(1).max(10_000).nullable(),
    maxUsers: z.number().int().min(1).max(100_000).nullable(),
    maxDevices: z.number().int().min(0).max(100_000).nullable(),
    features: z.array(z.enum(planFeatures)).max(planFeatures.length),
    trialDays: z.number().int().min(0).max(90),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  });

  router.get('/platform/plans', ...admin, async (_req, res) => {
    const plans = await db.plan.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { subscriptions: true } } },
    });
    res.json({
      plans: plans.map((plan) => ({
        ...planView(plan),
        sortOrder: plan.sortOrder,
        subscriptionCount: plan._count.subscriptions,
      })),
      features: planFeatures,
    });
  });

  router.post(
    '/platform/plans',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(planInput, req.body);
      try {
        const plan = await db.$transaction(async (tx) => {
          const created = await tx.plan.create({
            data: { ...input, features: [...new Set(input.features)] },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'platform.plan.create',
            entityType: 'plan',
            entityId: created.id,
            data: { code: input.code },
          });
          return created;
        });
        res.status(201).json({ id: plan.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.put(
    '/platform/plans/:id',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(planInput, req.body);
      try {
        await db.$transaction(async (tx) => {
          const found = await tx.plan.findUnique({ where: { id } });
          if (!found) throw errors.notFound();
          await tx.plan.update({
            where: { id },
            data: { ...input, features: [...new Set(input.features)] },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'platform.plan.update',
            entityType: 'plan',
            entityId: id,
            data: {
              code: input.code,
              monthlyPrice: input.monthlyPrice,
              yearlyPrice: input.yearlyPrice,
            },
          });
        });
        res.json({ ok: true });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.get('/platform/subscriptions', ...admin, async (_req, res) => {
    const tenants = await db.tenant.findMany({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'desc' },
      include: {
        subscription: { include: { plan: true } },
        invoices: { where: { status: 'OPEN' }, select: { amount: true } },
      },
    });
    res.json({
      subscriptions: tenants.map((tenant) => ({
        tenantId: tenant.id,
        tenantName: tenant.name,
        slug: tenant.slug,
        tenantStatus: tenant.status,
        status: tenant.subscription?.status ?? null,
        planCode: tenant.subscription?.plan.code ?? null,
        billingCycle: tenant.subscription?.billingCycle ?? null,
        trialEndsAt: tenant.subscription?.trialEndsAt ?? null,
        currentPeriodEnd: tenant.subscription?.currentPeriodEnd ?? null,
        openBalance: tenant.invoices.reduce((sum, i) => sum + i.amount, 0),
      })),
    });
  });

  router.post(
    '/platform/tenants/:id/subscription',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const tenantId = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({ planCode: planCodeSchema, billingCycle: cycleSchema }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const tenant = await tx.tenant.findFirst({
          where: { id: tenantId, kind: 'BUSINESS', status: { not: 'CLOSED' } },
        });
        if (!tenant) throw errors.notFound();
        const plan = await tx.plan.findUnique({
          where: { code: input.planCode },
        });
        if (!plan) throw errors.validation([{ path: 'planCode' }]);
        await changePlan(tx, tenantId, plan, input.billingCycle, now());
        await audit(tx, req, {
          tenantId,
          actorUserId: auth.userId,
          action: 'platform.subscription.change',
          entityType: 'tenant',
          entityId: tenantId,
          data: { planCode: plan.code, billingCycle: input.billingCycle },
        });
      });
      res.json({ ok: true });
    },
  );

  router.get('/platform/invoices', ...admin, async (req, res) => {
    const { status } = parse(
      z.object({ status: z.enum(['OPEN', 'PAID', 'VOID']).optional() }),
      req.query,
    );
    const invoices = await db.invoice.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { tenant: { select: { name: true, slug: true } } },
    });
    res.json({
      invoices: invoices.map((invoice) => ({
        ...invoiceView(invoice),
        tenantName: invoice.tenant.name,
        slug: invoice.tenant.slug,
        overdue: invoice.status === 'OPEN' && invoice.dueDate <= now(),
      })),
    });
  });

  router.post(
    '/platform/invoices/:id/pay',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { reference } = parse(
        z.object({ reference: z.string().trim().min(2).max(100) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const invoice = await markInvoicePaid(tx, id, reference, now());
        if (!invoice) throw errors.conflict();
        await audit(tx, req, {
          tenantId: invoice.tenantId,
          actorUserId: auth.userId,
          action: 'platform.invoice.paid',
          entityType: 'invoice',
          entityId: id,
          data: { amount: invoice.amount, reference },
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/platform/invoices/:id/void',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const invoice = await tx.invoice.findUnique({ where: { id } });
        if (!invoice || invoice.status !== 'OPEN') throw errors.conflict();
        await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
        await audit(tx, req, {
          tenantId: invoice.tenantId,
          actorUserId: auth.userId,
          action: 'platform.invoice.void',
          entityType: 'invoice',
          entityId: id,
          data: { amount: invoice.amount },
        });
      });
      res.json({ ok: true });
    },
  );

  router.post('/platform/billing/run', ...admin, async (_req, res) => {
    res.json(await runBillingCycle(services));
  });

  router.get('/platform/analytics', ...admin, async (_req, res) => {
    const at = now();
    const since = new Date(at.getTime() - 30 * DAY);
    const [tenants, subscriptions, openInvoices, paid30, closed30] =
      await Promise.all([
        db.tenant.groupBy({
          by: ['status'],
          where: { kind: 'BUSINESS' },
          _count: { _all: true },
        }),
        db.subscription.findMany({ include: { plan: true } }),
        db.invoice.findMany({
          where: { status: 'OPEN' },
          select: { amount: true, dueDate: true },
        }),
        db.invoice.aggregate({
          where: { status: 'PAID', paidAt: { gte: since } },
          _sum: { amount: true },
        }),
        db.tenant.count({
          where: { kind: 'BUSINESS', closedAt: { gte: since } },
        }),
      ]);
    const byStatus: Record<string, number> = {};
    let mrr = 0;
    let paying = 0;
    const byPlan: Record<string, number> = {};
    for (const subscription of subscriptions) {
      byStatus[subscription.status] = (byStatus[subscription.status] ?? 0) + 1;
      if (['ACTIVE', 'PAST_DUE'].includes(subscription.status)) {
        const value = monthlyValue(
          subscription.plan,
          subscription.billingCycle,
        );
        mrr += value;
        if (value > 0) paying += 1;
        byPlan[subscription.plan.code] =
          (byPlan[subscription.plan.code] ?? 0) + 1;
      }
    }
    const activeAtStart = paying + closed30;
    res.json({
      tenants: Object.fromEntries(
        tenants.map((row) => [row.status, row._count._all]),
      ),
      subscriptions: byStatus,
      byPlan,
      mrr,
      arr: mrr * 12,
      arpa: paying > 0 ? Math.round(mrr / paying) : 0,
      payingTenants: paying,
      openAmount: openInvoices.reduce((sum, i) => sum + i.amount, 0),
      overdueAmount: openInvoices
        .filter((i) => i.dueDate <= at)
        .reduce((sum, i) => sum + i.amount, 0),
      collected30d: paid30._sum.amount ?? 0,
      closed30d: closed30,
      churnRate30d:
        activeAtStart > 0
          ? Math.round((closed30 / activeAtStart) * 10_000) / 100
          : 0,
    });
  });

  return router;
}

/**
 * Applies a plan to a tenant. A trial keeps its end date; an existing paid period keeps
 * its dates and the new price applies from the next invoice. A tenant without a
 * subscription starts a paid period now and receives its first invoice immediately.
 */
async function changePlan(
  tx: Parameters<Parameters<Db['$transaction']>[0]>[0],
  tenantId: string,
  plan: { id: string; code: string; monthlyPrice: number; yearlyPrice: number },
  billingCycle: 'MONTHLY' | 'YEARLY',
  at: Date,
) {
  const existing = await tx.subscription.findUnique({ where: { tenantId } });
  if (existing) {
    await tx.subscription.update({
      where: { id: existing.id },
      data: { planId: plan.id, billingCycle },
    });
    return;
  }
  const periodEnd = addCycle(at, billingCycle);
  const subscription = await tx.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: 'ACTIVE',
      billingCycle,
      currentPeriodStart: at,
      currentPeriodEnd: periodEnd,
    },
  });
  const amount = priceFor(plan, billingCycle);
  await tx.invoice.create({
    data: {
      tenantId,
      subscriptionId: subscription.id,
      planCode: plan.code,
      periodStart: at,
      periodEnd,
      amount,
      status: amount === 0 ? 'PAID' : 'OPEN',
      paidAt: amount === 0 ? at : null,
      dueDate: new Date(at.getTime() + INVOICE_DUE_DAYS * DAY),
    },
  });
}
