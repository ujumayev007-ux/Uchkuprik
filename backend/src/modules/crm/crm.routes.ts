import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import {
  addEvent,
  editableStatuses,
  lockOrder,
  recalculate,
} from '../orders/engine.js';
import { postLoyalty, tierOf, upsertCustomer } from './loyalty.js';

const phone = z.string().trim().min(7).max(20);
const couponInput = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,30}$/),
    kind: z.enum(['PERCENT', 'FIXED']),
    value: z.number().int().min(1).max(1_000_000_000),
    minOrder: z.number().int().min(0).max(1_000_000_000).default(0),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
    validFrom: z.coerce.date().nullable().optional(),
    validTo: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .refine((coupon) => coupon.kind !== 'PERCENT' || coupon.value <= 10_000, {
    path: ['value'],
  });

export function crmRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  const notify = async (orderId: string) => {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (order)
      services.events?.publish({
        type: 'order.changed',
        tenantId: order.tenantId,
        branchId: order.branchId,
        orderId,
        number: order.number,
        status: order.status,
      });
  };

  // --- Customers ----------------------------------------------------------

  router.get(
    '/customers',
    requireAuth(),
    requirePermission('customers.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const { q } = parse(
        z.object({ q: z.string().trim().max(60).optional() }),
        req.query,
      );
      const digits = q?.replace(/\D/g, '') ?? '';
      const customers = await db.customer.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q
            ? {
                OR: [
                  ...(digits.length >= 3
                    ? [{ phone: { contains: digits } }]
                    : []),
                  { name: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [
          { lastOrderAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        take: 100,
      });
      res.json({
        customers: customers.map((customer) => ({
          id: customer.id,
          phone: customer.phone,
          name: customer.name,
          points: customer.points,
          totalSpent: customer.totalSpent,
          orderCount: customer.orderCount,
          lastOrderAt: customer.lastOrderAt,
          marketingConsent: customer.marketingConsent,
          tier: tierOf(customer.totalSpent),
        })),
      });
    },
  );

  router.get(
    '/customers/:id',
    requireAuth(),
    requirePermission('customers.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const customer = await db.customer.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!customer) throw errors.notFound();
      const [orders, loyalty] = await Promise.all([
        db.order.findMany({
          where: { tenantId: auth.tenantId, customerId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            number: true,
            status: true,
            total: true,
            createdAt: true,
            channel: true,
            type: true,
          },
        }),
        db.loyaltyEntry.findMany({
          where: { customerId: id },
          orderBy: { id: 'desc' },
          take: 50,
        }),
      ]);
      res.json({
        customer: { ...customer, tier: tierOf(customer.totalSpent) },
        orders,
        loyalty: loyalty.map((entry) => ({
          ...entry,
          id: entry.id.toString(),
        })),
      });
    },
  );

  router.patch(
    '/customers/:id',
    requireAuth(),
    requirePermission('customers.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          name: z.string().trim().max(80).nullable().optional(),
          birthday: z.coerce.date().nullable().optional(),
          marketingConsent: z.boolean(),
          notes: z.string().trim().max(500).nullable().optional(),
        }),
        req.body,
      );
      const customer = await db.customer.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!customer) throw errors.notFound();
      await db.customer.update({
        where: { id },
        data: {
          name: input.name ?? null,
          birthday: input.birthday ?? null,
          notes: input.notes ?? null,
          marketingConsent: input.marketingConsent,
          // Consent time is recorded when consent is given (and cleared when withdrawn).
          consentAt: input.marketingConsent
            ? customer.marketingConsent
              ? customer.consentAt
              : now()
            : null,
        },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        data: { marketingConsent: input.marketingConsent },
      });
      res.json({ ok: true });
    },
  );

  // Manual point corrections need re-authentication and a reason.
  router.post(
    '/customers/:id/points',
    requireAuth(),
    requirePermission('customers.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          points: z
            .number()
            .int()
            .min(-1_000_000)
            .max(1_000_000)
            .refine((value) => value !== 0),
          reason: z.string().trim().min(3).max(200),
        }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        await postLoyalty(tx, {
          tenantId: auth.tenantId,
          customerId: id,
          type: 'ADJUST',
          points: input.points,
          reason: input.reason,
          actorId: auth.userId,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'customer.points.adjust',
          entityType: 'customer',
          entityId: id,
          data: input,
        });
      });
      res.json({ ok: true });
    },
  );

  // Marketing list: only customers who gave consent.
  router.get(
    '/customers-export/marketing',
    requireAuth(),
    requirePermission('customers.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const customers = await db.customer.findMany({
        where: { tenantId: auth.tenantId, marketingConsent: true },
        orderBy: { createdAt: 'asc' },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'customer.export',
        data: { count: customers.length },
      });
      const escape = (value: string | null) =>
        `"${(value ?? '').replace(/"/g, '""')}"`;
      res.type('text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="mijozlar.csv"',
      );
      res.send(
        [
          'phone,name,consent_at',
          ...customers.map((c) =>
            [
              escape(c.phone),
              escape(c.name),
              escape(c.consentAt?.toISOString() ?? null),
            ].join(','),
          ),
        ].join('\n'),
      );
    },
  );

  // --- Order customer and coupon -------------------------------------------

  router.post(
    '/orders/:id/customer',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          phone,
          name: z.string().trim().max(80).nullable().optional(),
        }),
        req.body,
      );
      const customer = await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const customer = await upsertCustomer(
          tx,
          auth.tenantId,
          input.phone,
          input.name,
        );
        await tx.order.update({
          where: { id },
          data: {
            customerId: customer.id,
            customerPhone: customer.phone,
            customerName: customer.name ?? order.customerName,
            version: { increment: 1 },
          },
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'customer', {
          customerId: customer.id,
        });
        return customer;
      });
      await notify(id);
      res.json({
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          points: customer.points,
          tier: tierOf(customer.totalSpent),
        },
      });
    },
  );

  router.post(
    '/orders/:id/coupon',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { code } = parse(
        z.object({ code: z.string().trim().toUpperCase().min(3).max(30) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        if (order.couponId) throw errors.conflict();
        const coupon = await tx.coupon.findUnique({
          where: { tenantId_code: { tenantId: auth.tenantId, code } },
        });
        const at = now();
        if (
          !coupon ||
          !coupon.isActive ||
          (coupon.validFrom && coupon.validFrom > at) ||
          (coupon.validTo && coupon.validTo < at)
        )
          throw new AppError(400, 'COUPON_INVALID', 'couponInvalid');
        if (order.subtotal < coupon.minOrder)
          throw new AppError(400, 'COUPON_MIN_ORDER', 'couponMinOrder');
        // Atomic usage check: concurrent orders cannot exceed maxUses.
        const claimed = await tx.$executeRaw`
        UPDATE coupons SET "usedCount" = "usedCount" + 1
        WHERE id = ${coupon.id}::uuid AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
        if (claimed === 0)
          throw new AppError(409, 'COUPON_EXHAUSTED', 'couponExhausted');
        await tx.order.update({
          where: { id },
          data: {
            couponId: coupon.id,
            discountBp: coupon.kind === 'PERCENT' ? coupon.value : 0,
            discountFixed: coupon.kind === 'FIXED' ? coupon.value : 0,
            discountReason: `Promokod: ${coupon.code}`,
          },
        });
        await recalculate(tx, id);
        await addEvent(tx, auth.tenantId, id, auth.userId, 'coupon', {
          code: coupon.code,
        });
      });
      await notify(id);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/orders/:id/coupon',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (!order.couponId || !editableStatuses.includes(order.status))
          throw errors.notFound();
        await tx.coupon.updateMany({
          where: { id: order.couponId, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        });
        await tx.order.update({
          where: { id },
          data: {
            couponId: null,
            discountBp: 0,
            discountFixed: 0,
            discountReason: null,
          },
        });
        await recalculate(tx, id);
        await addEvent(tx, auth.tenantId, id, auth.userId, 'coupon', {
          removed: true,
        });
      });
      await notify(id);
      res.status(204).end();
    },
  );

  // --- Coupons --------------------------------------------------------------

  router.get(
    '/coupons',
    requireAuth(),
    requirePermission('customers.manage'),
    async (_req, res) => {
      const auth = getAuth(res);
      const coupons = await db.coupon.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ coupons });
    },
  );

  router.post(
    '/coupons',
    requireAuth(),
    requirePermission('customers.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(couponInput, req.body);
      try {
        const coupon = await db.coupon.create({
          data: {
            tenantId: auth.tenantId,
            code: input.code,
            kind: input.kind,
            value: input.value,
            minOrder: input.minOrder,
            maxUses: input.maxUses ?? null,
            validFrom: input.validFrom ?? null,
            validTo: input.validTo ?? null,
            isActive: input.isActive,
          },
        });
        await audit(db, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'coupon.create',
          entityType: 'coupon',
          entityId: coupon.id,
          data: { code: input.code },
        });
        res.status(201).json({ id: coupon.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.patch(
    '/coupons/:id',
    requireAuth(),
    requirePermission('customers.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
      const result = await db.coupon.updateMany({
        where: { id, tenantId: auth.tenantId },
        data: { isActive },
      });
      if (result.count === 0) throw errors.notFound();
      res.json({ ok: true });
    },
  );

  // --- Feedback (CSAT) ----------------------------------------------------

  router.post('/public/orders/:token/feedback', async (req, res) => {
    const token = parse(
      z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
      req.params.token,
    );
    const input = parse(
      z.object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().max(1000).nullable().optional(),
      }),
      req.body,
    );
    const order = await db.order.findUnique({
      where: { trackingToken: token },
    });
    if (!order || !['READY', 'SERVED', 'COMPLETED'].includes(order.status))
      throw errors.notFound();
    try {
      await db.feedback.create({
        data: {
          tenantId: order.tenantId,
          branchId: order.branchId,
          orderId: order.id,
          rating: input.rating,
          comment: input.comment ?? null,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError(409, 'FEEDBACK_EXISTS', 'feedbackExists');
      throw error;
    }
    res.status(201).json({ ok: true });
  });

  router.get(
    '/feedback',
    requireAuth(),
    requirePermission('customers.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const { branchId } = parse(
        z.object({ branchId: z.uuid().optional() }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, branchId);
      const rows = await db.feedback.findMany({
        where: { tenantId: auth.tenantId, branchId: branch.id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const orders = await db.order.findMany({
        where: { id: { in: rows.map((row) => row.orderId) } },
        select: {
          id: true,
          number: true,
          customerName: true,
          customerPhone: true,
        },
      });
      const byId = new Map(orders.map((order) => [order.id, order]));
      const count = rows.length;
      const satisfied = rows.filter((row) => row.rating >= 4).length;
      res.json({
        stats: {
          count,
          averageRating: count
            ? Math.round(
                (rows.reduce((sum, row) => sum + row.rating, 0) / count) * 10,
              ) / 10
            : null,
          // CSAT: share of 4-5 star ratings, in percent.
          csat: count ? Math.round((satisfied / count) * 100) : null,
          openComplaints: rows.filter(
            (row) => row.rating <= 2 && row.status === 'NEW',
          ).length,
        },
        feedback: rows.map((row) => ({
          ...row,
          order: byId.get(row.orderId) ?? null,
        })),
      });
    },
  );

  router.post(
    '/feedback/:id/resolve',
    requireAuth(),
    requirePermission('customers.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { resolution } = parse(
        z.object({ resolution: z.string().trim().min(3).max(500) }),
        req.body,
      );
      const result = await db.feedback.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'NEW' },
        data: {
          status: 'RESOLVED',
          resolution,
          resolvedById: auth.userId,
          resolvedAt: now(),
        },
      });
      if (result.count === 0) throw errors.notFound();
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'feedback.resolve',
        entityType: 'feedback',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  return router;
}
