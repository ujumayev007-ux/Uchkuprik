import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
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
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { postLoyalty } from '../crm/loyalty.js';
import { findOpenShift } from '../shifts/shifts.routes.js';
import {
  addEvent,
  assertTransition,
  businessDate,
  computeTotals,
  editableStatuses,
  itemCreateData,
  lockOrder,
  netPaid,
  nextOrderNumber,
  priceItems,
  recalculate,
  syncKitchenStatus,
} from './engine.js';
import { completeOrder } from './complete.js';

const amount = z.number().int().min(1).max(1_000_000_000);
const itemSchema = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(999),
  modifierOptionIds: z.array(z.uuid()).max(30).default([]),
  note: z.string().trim().max(200).nullable().optional(),
});
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/);
const idempotencyKey = z.string().trim().min(8).max(80);

// Methods accepted at the counter. Online providers (Click, Payme, Uzum) are only
// accepted through verified provider callbacks (Phase 8), never as manual entries.
const counterMethods = ['CASH', 'CARD', 'LOYALTY'] as const;

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { items: true; payments: true; refunds: true; table: true };
}>;

function serialize(order: OrderWithRelations, auth: AuthContext) {
  const showCost = auth.permissions.has('finance.view');
  return {
    id: order.id,
    branchId: order.branchId,
    number: order.number,
    businessDate: order.businessDate.toISOString().slice(0, 10),
    type: order.type,
    channel: order.channel,
    status: order.status,
    table: order.table ? { id: order.table.id, name: order.table.name } : null,
    customerId: order.customerId,
    couponId: order.couponId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    note: order.note,
    subtotal: order.subtotal,
    discountBp: order.discountBp,
    discountFixed: order.discountFixed,
    discountTotal: order.discountTotal,
    discountReason: order.discountReason,
    serviceChargeBp: order.serviceChargeBp,
    serviceCharge: order.serviceCharge,
    total: order.total,
    paidTotal: order.paidTotal,
    refundedTotal: order.refundedTotal,
    due: Math.max(0, order.total - netPaid(order)),
    version: order.version,
    createdAt: order.createdAt,
    placedAt: order.placedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    items: order.items
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((item) => ({
        id: item.id,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        unitPrice: item.unitPrice,
        modifiers: item.modifiers,
        modifiersTotal: item.modifiersTotal,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        note: item.note,
        status: item.status,
        cancelReason: item.cancelReason,
        ...(showCost ? { unitCost: item.unitCost } : {}),
      })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amount: payment.amount,
      tendered: payment.tendered,
      change: payment.change,
      reference: payment.reference,
      createdAt: payment.createdAt,
    })),
    refunds: order.refunds.map((refund) => ({
      id: refund.id,
      paymentId: refund.paymentId,
      method: refund.method,
      amount: refund.amount,
      reason: refund.reason,
      createdAt: refund.createdAt,
    })),
  };
}

export function ordersRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  const load = async (auth: AuthContext, id: string) => {
    const order = await db.order.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { items: true, payments: true, refunds: true, table: true },
    });
    if (!order) throw errors.notFound();
    await resolveBranch(db, auth, order.branchId);
    return order;
  };

  /** Runs a change under the order row lock with branch-scope and edit checks. */
  const mutate = async <T>(
    auth: AuthContext,
    id: string,
    fn: (tx: Tx, order: Awaited<ReturnType<typeof lockOrder>>) => Promise<T>,
  ) =>
    db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      return fn(tx, order);
    });

  const respond = async (auth: AuthContext, id: string) =>
    serialize(await load(auth, id), auth);

  /** After a committed change: notify kitchen/POS screens, then return the order. */
  const respondChanged = async (auth: AuthContext, id: string) => {
    const order = await load(auth, id);
    await services.afterOrderChange?.(order.id);
    services.events?.publish({
      type: 'order.changed',
      tenantId: order.tenantId,
      branchId: order.branchId,
      orderId: order.id,
      number: order.number,
      status: order.status,
    });
    return serialize(order, auth);
  };

  const assertTable = async (
    tx: Tx,
    auth: AuthContext,
    branchId: string,
    tableId: string | null | undefined,
  ) => {
    if (!tableId) return null;
    const table = await tx.diningTable.findFirst({
      where: { id: tableId, tenantId: auth.tenantId, branchId, isActive: true },
    });
    if (!table) throw errors.validation([{ path: 'tableId' }]);
    return table.id;
  };

  router.get(
    '/orders',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          scope: z.enum(['active', 'today', 'all']).default('active'),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const today = businessDate(now(), branch.timezone);
      const orders = await db.order.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          ...(query.scope === 'active'
            ? {
                status: {
                  in: [
                    'DRAFT',
                    'PENDING',
                    'PLACED',
                    'PREPARING',
                    'READY',
                    'SERVED',
                  ],
                },
              }
            : query.scope === 'today'
              ? { businessDate: today }
              : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        include: { items: true, payments: true, refunds: true, table: true },
      });
      res.json({ orders: orders.map((order) => serialize(order, auth)) });
    },
  );

  router.get(
    '/orders/:id',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      res.json(await respond(auth, parse(z.uuid(), req.params.id)));
    },
  );

  router.post(
    '/orders',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z
          .object({
            idempotencyKey,
            branchId: z.uuid().optional(),
            type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
            tableId: z.uuid().nullable().optional(),
            customerName: z.string().trim().max(80).nullable().optional(),
            customerPhone: phone.nullable().optional(),
            deliveryAddress: z.string().trim().max(300).nullable().optional(),
            note: z.string().trim().max(300).nullable().optional(),
            items: z.array(itemSchema).max(100).default([]),
            place: z.boolean().default(false),
          })
          .refine(
            (order) =>
              order.type !== 'DELIVERY' ||
              (order.deliveryAddress && order.customerPhone),
            {
              path: ['deliveryAddress'],
            },
          )
          .refine((order) => !order.place || order.items.length > 0, {
            path: ['items'],
          }),
        req.body,
      );
      // Retried requests return the original order instead of creating a duplicate.
      const existing = await db.order.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: auth.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        res.status(200).json(await respond(auth, existing.id));
        return;
      }
      const branch = await resolveBranch(db, auth, input.branchId);
      const profile = await db.tenantProfile.findUnique({
        where: { tenantId: auth.tenantId },
      });
      try {
        const id = await db.$transaction(async (tx) => {
          const tableId = await assertTable(
            tx,
            auth,
            branch.id,
            input.type === 'DINE_IN' ? input.tableId : null,
          );
          const priced = await priceItems(
            tx,
            auth.tenantId,
            branch.id,
            input.items,
          );
          const date = businessDate(now(), branch.timezone);
          const number = await nextOrderNumber(tx, branch.id, date);
          const subtotal = priced.reduce(
            (sum, item) => sum + item.lineTotal,
            0,
          );
          const serviceChargeBp =
            input.type === 'DINE_IN' ? (profile?.serviceChargeBp ?? 0) : 0;
          const totals = computeTotals({
            subtotal,
            discountBp: 0,
            discountFixed: 0,
            serviceChargeBp,
          });
          const order = await tx.order.create({
            data: {
              tenantId: auth.tenantId,
              branchId: branch.id,
              number,
              businessDate: date,
              type: input.type,
              channel: 'POS',
              status: input.place ? 'PLACED' : 'DRAFT',
              placedAt: input.place ? now() : null,
              tableId,
              customerName: input.customerName ?? null,
              customerPhone: input.customerPhone ?? null,
              deliveryAddress:
                input.type === 'DELIVERY'
                  ? (input.deliveryAddress ?? null)
                  : null,
              note: input.note ?? null,
              subtotal,
              serviceChargeBp,
              ...totals,
              idempotencyKey: input.idempotencyKey,
              createdById: auth.userId,
            },
          });
          if (priced.length)
            await tx.orderItem.createMany({
              data: priced.map((item) =>
                itemCreateData(auth.tenantId, order.id, auth.userId, item),
              ),
            });
          await addEvent(tx, auth.tenantId, order.id, auth.userId, 'created', {
            status: order.status,
            items: priced.length,
            total: order.total,
          });
          return order.id;
        });
        res.status(201).json(await respondChanged(auth, id));
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await db.order.findUnique({
            where: {
              tenantId_idempotencyKey: {
                tenantId: auth.tenantId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (raced) {
            res.status(200).json(await respond(auth, raced.id));
            return;
          }
        }
        throw error;
      }
    },
  );

  router.post(
    '/orders/:id/items',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({ items: z.array(itemSchema).min(1).max(100) }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const priced = await priceItems(
          tx,
          auth.tenantId,
          order.branchId,
          input.items,
        );
        await tx.orderItem.createMany({
          data: priced.map((item) =>
            itemCreateData(auth.tenantId, order.id, auth.userId, item),
          ),
        });
        await recalculate(tx, order.id);
        await syncKitchenStatus(tx, order.id, now());
        await addEvent(
          tx,
          auth.tenantId,
          order.id,
          auth.userId,
          'items_added',
          {
            items: priced.map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
            })),
          },
        );
      });
      res.json(await respondChanged(auth, id));
    },
  );

  // Quantity changes are allowed before the order is sent; afterwards items are cancelled instead.
  router.patch(
    '/orders/:id/items/:itemId',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const itemId = parse(z.uuid(), req.params.itemId);
      const { quantity } = parse(
        z.object({ quantity: z.number().int().min(1).max(999) }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        if (order.status !== 'DRAFT')
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const item = await tx.orderItem.findFirst({
          where: { id: itemId, orderId: id, status: 'ACTIVE' },
        });
        if (!item) throw errors.notFound();
        await tx.orderItem.update({
          where: { id: itemId },
          data: {
            quantity,
            lineTotal: (item.unitPrice + item.modifiersTotal) * quantity,
          },
        });
        await recalculate(tx, id);
        await addEvent(tx, auth.tenantId, id, auth.userId, 'item_quantity', {
          itemId,
          from: item.quantity,
          to: quantity,
        });
      });
      res.json(await respondChanged(auth, id));
    },
  );

  router.post(
    '/orders/:id/items/:itemId/cancel',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const itemId = parse(z.uuid(), req.params.itemId);
      const { reason } = parse(
        z.object({ reason: z.string().trim().max(200).default('') }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        // Items already sent to the kitchen need cancellation rights and a reason.
        if (order.status !== 'DRAFT') {
          if (!auth.permissions.has('orders.cancel')) throw errors.forbidden();
          if (reason.length < 3) throw errors.validation([{ path: 'reason' }]);
        }
        const item = await tx.orderItem.findFirst({
          where: { id: itemId, orderId: id, status: 'ACTIVE' },
        });
        if (!item) throw errors.notFound();
        await tx.orderItem.update({
          where: { id: itemId },
          data: { status: 'CANCELLED', cancelReason: reason || null },
        });
        await recalculate(tx, id);
        await syncKitchenStatus(tx, id, now());
        await addEvent(tx, auth.tenantId, id, auth.userId, 'item_cancelled', {
          itemId,
          reason,
        });
        if (order.status !== 'DRAFT')
          await audit(tx, req, {
            tenantId: auth.tenantId,
            branchId: order.branchId,
            actorUserId: auth.userId,
            action: 'order.item.cancel',
            entityType: 'order',
            entityId: id,
            data: { itemId, reason, lineTotal: item.lineTotal },
          });
      });
      res.json(await respondChanged(auth, id));
    },
  );

  router.patch(
    '/orders/:id',
    requireAuth(),
    requirePermission('orders.edit'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          tableId: z.uuid().nullable().optional(),
          customerName: z.string().trim().max(80).nullable().optional(),
          customerPhone: phone.nullable().optional(),
          deliveryAddress: z.string().trim().max(300).nullable().optional(),
          note: z.string().trim().max(300).nullable().optional(),
        }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const data: Prisma.OrderUncheckedUpdateInput = {
          version: { increment: 1 },
        };
        if (input.tableId !== undefined) {
          if (order.type !== 'DINE_IN' && input.tableId)
            throw errors.validation([{ path: 'tableId' }]);
          data.tableId = await assertTable(
            tx,
            auth,
            order.branchId,
            input.tableId,
          );
        }
        if (input.customerName !== undefined)
          data.customerName = input.customerName;
        if (input.customerPhone !== undefined)
          data.customerPhone = input.customerPhone;
        if (input.deliveryAddress !== undefined)
          data.deliveryAddress = input.deliveryAddress;
        if (input.note !== undefined) data.note = input.note;
        await tx.order.update({ where: { id }, data });
        await addEvent(
          tx,
          auth.tenantId,
          id,
          auth.userId,
          'details_updated',
          JSON.parse(JSON.stringify(input)),
        );
      });
      res.json(await respondChanged(auth, id));
    },
  );

  router.post(
    '/orders/:id/discount',
    requireAuth(),
    requirePermission('discounts.apply'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          percentBp: z.number().int().min(0).max(10_000).default(0),
          fixed: z.number().int().min(0).max(1_000_000_000).default(0),
          reason: z.string().trim().max(200).default(''),
        }),
        req.body,
      );
      if ((input.percentBp > 0 || input.fixed > 0) && input.reason.length < 3)
        throw errors.validation([{ path: 'reason' }]);
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        await tx.order.update({
          where: { id },
          data: {
            discountBp: input.percentBp,
            discountFixed: input.fixed,
            discountReason: input.reason || null,
          },
        });
        const updated = await recalculate(tx, id);
        await addEvent(tx, auth.tenantId, id, auth.userId, 'discount', {
          ...input,
          discountTotal: updated.discountTotal,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'order.discount',
          entityType: 'order',
          entityId: id,
          data: { ...input, discountTotal: updated.discountTotal },
        });
      });
      res.json(await respondChanged(auth, id));
    },
  );

  const transition = async (
    auth: AuthContext,
    id: string,
    to: 'PLACED' | 'COMPLETED',
  ) => {
    await mutate(auth, id, async (tx, order) => {
      assertTransition(order.status, to);
      if (to === 'PLACED') {
        const items = await tx.orderItem.count({
          where: { orderId: id, status: 'ACTIVE' },
        });
        if (items === 0) throw errors.validation([{ path: 'items' }]);
      }
      if (to === 'COMPLETED')
        return completeOrder(tx, order, auth.userId, now());
      await tx.order.update({
        where: { id },
        data: {
          status: to,
          version: { increment: 1 },
          ...(to === 'PLACED' ? { placedAt: now() } : { completedAt: now() }),
        },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
        from: order.status,
        to,
      });
    });
  };

  router.post(
    '/orders/:id/place',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await transition(auth, id, 'PLACED');
      res.json(await respondChanged(auth, id));
    },
  );

  router.post(
    '/orders/:id/complete',
    requireAuth(),
    requirePermission('orders.edit'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await transition(auth, id, 'COMPLETED');
      res.json(await respondChanged(auth, id));
    },
  );

  router.post(
    '/orders/:id/cancel',
    requireAuth(),
    requirePermission('orders.cancel'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { reason } = parse(
        z.object({ reason: z.string().trim().min(3).max(200) }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        assertTransition(order.status, 'CANCELLED');
        if (netPaid(order) > 0)
          throw new AppError(409, 'PAID_ORDER', 'paidOrderCancel');
        await tx.order.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now(),
            cancelReason: reason,
            version: { increment: 1 },
          },
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
          from: order.status,
          to: 'CANCELLED',
          reason,
        });
        // A cancelled order gives its coupon use back.
        if (order.couponId)
          await tx.coupon.updateMany({
            where: { id: order.couponId, usedCount: { gt: 0 } },
            data: { usedCount: { decrement: 1 } },
          });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'order.cancel',
          entityType: 'order',
          entityId: id,
          data: { reason, total: order.total, status: order.status },
        });
      });
      res.json(await respondChanged(auth, id));
    },
  );

  router.post(
    '/orders/:id/payments',
    requireAuth(),
    requirePermission('payments.accept'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z
          .object({
            idempotencyKey,
            method: z.enum([
              'CASH',
              'CARD',
              'LOYALTY',
              'CLICK',
              'PAYME',
              'UZUM',
              'OTHER',
            ]),
            amount,
            tendered: z.number().int().min(1).max(1_000_000_000).optional(),
            reference: z.string().trim().max(60).nullable().optional(),
          })
          .refine(
            (payment) =>
              payment.method !== 'CASH' || payment.tendered !== undefined,
            { path: ['tendered'] },
          ),
        req.body,
      );
      if (
        !counterMethods.includes(
          input.method as (typeof counterMethods)[number],
        )
      )
        throw new AppError(
          400,
          'PROVIDER_NOT_CONFIGURED',
          'providerNotConfigured',
        );
      const existing = await db.payment.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: auth.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.orderId !== id) throw errors.conflict();
        res.status(200).json({
          paymentId: existing.id,
          change: existing.change,
          order: await respondChanged(auth, id),
        });
        return;
      }
      try {
        const payment = await mutate(auth, id, async (tx, order) => {
          if (!editableStatuses.includes(order.status))
            throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
          // Online orders are approved before money is taken.
          if (order.status === 'PENDING')
            throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
          const shift = await findOpenShift(tx, auth, order.branchId);
          if (!shift)
            throw new AppError(409, 'SHIFT_REQUIRED', 'shiftRequired');
          const due = order.total - netPaid(order);
          if (input.amount > due)
            throw new AppError(409, 'AMOUNT_EXCEEDS_DUE', 'amountExceedsDue', {
              due,
            });
          if (input.method === 'CASH' && input.tendered! < input.amount)
            throw new AppError(400, 'INSUFFICIENT_CASH', 'insufficientCash');
          if (input.method === 'LOYALTY' && !order.customerId)
            throw new AppError(409, 'CUSTOMER_REQUIRED', 'customerRequired');
          const change =
            input.method === 'CASH' ? input.tendered! - input.amount : null;
          const created = await tx.payment.create({
            data: {
              tenantId: auth.tenantId,
              branchId: order.branchId,
              orderId: id,
              shiftId: shift.id,
              method: input.method,
              amount: input.amount,
              tendered: input.method === 'CASH' ? input.tendered! : null,
              change,
              reference: input.reference ?? null,
              idempotencyKey: input.idempotencyKey,
              createdById: auth.userId,
            },
          });
          // Paying a draft sends it to the kitchen (typical fast-food counter flow).
          const placing = order.status === 'DRAFT';
          if (placing) {
            const items = await tx.orderItem.count({
              where: { orderId: id, status: 'ACTIVE' },
            });
            if (items === 0) throw errors.validation([{ path: 'items' }]);
          }
          await tx.order.update({
            where: { id },
            data: {
              paidTotal: { increment: input.amount },
              version: { increment: 1 },
              ...(placing ? { status: 'PLACED', placedAt: now() } : {}),
            },
          });
          // Points are redeemed 1:1 against the bill, under a lock on the customer.
          if (input.method === 'LOYALTY')
            await postLoyalty(tx, {
              tenantId: auth.tenantId,
              customerId: order.customerId!,
              type: 'REDEEM',
              points: -input.amount,
              orderId: id,
              paymentId: created.id,
              reason: `Buyurtma №${order.number}`,
              actorId: auth.userId,
            });
          await addEvent(tx, auth.tenantId, id, auth.userId, 'payment', {
            paymentId: created.id,
            method: input.method,
            amount: input.amount,
          });
          if (placing)
            await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
              from: 'DRAFT',
              to: 'PLACED',
            });
          return created;
        });
        res.status(201).json({
          paymentId: payment.id,
          change: payment.change,
          order: await respondChanged(auth, id),
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  // Refunds are approved by holders of payments.refund with fresh re-authentication.
  router.post(
    '/orders/:id/refunds',
    requireAuth(),
    requirePermission('payments.refund'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          paymentId: z.uuid(),
          amount,
          reason: z.string().trim().min(3).max(200),
        }),
        req.body,
      );
      await mutate(auth, id, async (tx, order) => {
        const payment = await tx.payment.findFirst({
          where: { id: input.paymentId, orderId: id },
        });
        if (!payment) throw errors.notFound();
        const refunded = await tx.refund.aggregate({
          where: { paymentId: payment.id },
          _sum: { amount: true },
        });
        if ((refunded._sum.amount ?? 0) + input.amount > payment.amount)
          throw new AppError(
            409,
            'REFUND_EXCEEDS_PAYMENT',
            'refundExceedsPayment',
          );
        // Cash leaves the refunding register's drawer, so an open shift is required.
        const shift = await findOpenShift(tx, auth, order.branchId);
        if (payment.method === 'CASH' && !shift)
          throw new AppError(409, 'SHIFT_REQUIRED', 'shiftRequired');
        const refund = await tx.refund.create({
          data: {
            tenantId: auth.tenantId,
            orderId: id,
            paymentId: payment.id,
            shiftId: shift?.id ?? null,
            method: payment.method,
            amount: input.amount,
            reason: input.reason,
            approvedById: auth.userId,
          },
        });
        await tx.order.update({
          where: { id },
          data: {
            refundedTotal: { increment: input.amount },
            version: { increment: 1 },
          },
        });
        // Refunded loyalty payments return the points to the customer.
        if (payment.method === 'LOYALTY' && order.customerId)
          await postLoyalty(tx, {
            tenantId: auth.tenantId,
            customerId: order.customerId,
            type: 'REVERSAL',
            points: input.amount,
            orderId: id,
            paymentId: payment.id,
            reason: input.reason,
            actorId: auth.userId,
          });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'refund', {
          refundId: refund.id,
          paymentId: payment.id,
          amount: input.amount,
          reason: input.reason,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'payment.refund',
          entityType: 'order',
          entityId: id,
          data: {
            refundId: refund.id,
            paymentId: payment.id,
            method: payment.method,
            amount: input.amount,
            reason: input.reason,
          },
        });
      });
      res.status(201).json(await respondChanged(auth, id));
    },
  );

  router.get(
    '/orders/:id/events',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await load(auth, id);
      const events = await db.orderEvent.findMany({
        where: { orderId: id },
        orderBy: { id: 'asc' },
      });
      const actors = await db.user.findMany({
        where: {
          id: {
            in: [
              ...new Set(
                events
                  .map((event) => event.actorId)
                  .filter((value) => value !== null),
              ),
            ],
          },
        },
        select: { id: true, displayName: true },
      });
      const names = new Map(
        actors.map((actor) => [actor.id, actor.displayName]),
      );
      res.json({
        events: events.map((event) => ({
          id: event.id.toString(),
          type: event.type,
          data: event.data,
          actor: event.actorId ? (names.get(event.actorId) ?? null) : null,
          createdAt: event.createdAt,
        })),
      });
    },
  );

  // Receipt data; rendering/printing happens on the client or a printer adapter.
  router.get(
    '/orders/:id/receipt',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const order = await load(auth, id);
      const [tenant, branch, cashier] = await Promise.all([
        db.tenant.findUniqueOrThrow({
          where: { id: auth.tenantId },
          include: { profile: true },
        }),
        db.branch.findUniqueOrThrow({ where: { id: order.branchId } }),
        order.createdById
          ? db.user.findUnique({
              where: { id: order.createdById },
              select: { displayName: true },
            })
          : null,
      ]);
      const data = serialize(order, { ...auth, permissions: new Set() });
      res.json({
        business: {
          name: tenant.name,
          legalName: tenant.profile?.legalName ?? null,
          taxId: tenant.profile?.taxId ?? null,
          phone: tenant.profile?.phone ?? null,
          header: tenant.profile?.receiptHeader ?? null,
          footer: tenant.profile?.receiptFooter ?? null,
        },
        branch: {
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
        },
        cashier: cashier?.displayName ?? null,
        // Fiscal sign/QR exist only after a certified fiscal provider registers the receipt.
        fiscal: (await db.fiscalReceipt.findUnique({
          where: { orderId: order.id },
          select: { status: true, fiscalSign: true, qrUrl: true },
        })) ?? { status: 'NOT_CONFIGURED', fiscalSign: null, qrUrl: null },
        order: {
          ...data,
          items: data.items.filter((item) => item.status === 'ACTIVE'),
        },
      });
    },
  );

  return router;
}
