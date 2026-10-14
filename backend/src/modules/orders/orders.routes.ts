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
import { qrPaymentOf, receiptSettingsOf } from '../settings/settings.routes.js';
import { emitWebhook } from '../developer/webhooks.js';
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
import { loadOrderSettings, placementStatus } from './settings.js';

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
// QR is a merchant QR (e.g. Paynet) confirmed by the cashier; it must be enabled by the owner.
const counterMethods = ['CASH', 'CARD', 'LOYALTY', 'QR'] as const;

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
    deliveryLandmark: order.deliveryLandmark,
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
        components: item.components,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        note: item.note,
        status: item.status,
        cancelReason: item.cancelReason,
        kitchenStatus: item.kitchenStatus,
        cancelRequested: item.cancelRequestedAt
          ? { reason: item.cancelRequestReason }
          : null,
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
  const respondChanged = async (
    auth: AuthContext,
    id: string,
    updated = false,
  ) => {
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
    // "123-sonli buyurtma yangilandi!" on cashier, kitchen and admin panels.
    if (updated && order.status !== 'DRAFT')
      services.events?.publish({
        type: 'order.updated',
        tenantId: order.tenantId,
        branchId: order.branchId,
        orderId: order.id,
        number: order.number,
        version: order.version,
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
            deliveryLandmark: z.string().trim().max(200).nullable().optional(),
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
          const placing = input.place
            ? await placementStatus(tx, auth.tenantId, auth.permissions)
            : 'DRAFT';
          const order = await tx.order.create({
            data: {
              tenantId: auth.tenantId,
              branchId: branch.id,
              number,
              businessDate: date,
              type: input.type,
              channel: 'POS',
              status: placing,
              placedAt: placing === 'PLACED' ? now() : null,
              tableId,
              customerName: input.customerName ?? null,
              customerPhone: input.customerPhone ?? null,
              deliveryAddress:
                input.type === 'DELIVERY'
                  ? (input.deliveryAddress ?? null)
                  : null,
              deliveryLandmark:
                input.type === 'DELIVERY'
                  ? (input.deliveryLandmark ?? null)
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
        await assertCanEditPlaced(tx, auth, order);
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
      res.json(await respondChanged(auth, id, true));
    },
  );

  /**
   * Who may change an order that already went to the kitchen: managers and cashiers
   * always, waiters when the restaurant allows it (Sozlamalar → Buyurtma jarayoni).
   */
  const assertCanEditPlaced = async (
    tx: Tx,
    auth: AuthContext,
    order: { status: string },
  ) => {
    if (order.status === 'DRAFT' || order.status === 'PENDING') return;
    if (
      auth.permissions.has('orders.cancel') ||
      auth.permissions.has('payments.accept')
    )
      return;
    if (!(await loadOrderSettings(tx, auth.tenantId)).waiterCanEditPlaced)
      throw errors.forbidden();
  };

  // Cancelling or reducing a sent item lowers the bill: managers only, unless the
  // restaurant explicitly allows staff to do it.
  const assertCanCancelPlaced = async (tx: Tx, auth: AuthContext) => {
    if (auth.permissions.has('orders.cancel')) return;
    if (!(await loadOrderSettings(tx, auth.tenantId)).staffCanCancelPlaced)
      throw errors.forbidden();
  };

  // Kitchen already working on it: the cook confirms the cancellation, unless a
  // manager overrides.
  const needsKitchenAck = async (
    tx: Tx,
    auth: AuthContext,
    item: { kitchenStatus: string },
    override: boolean,
  ) =>
    (item.kitchenStatus === 'PREPARING' || item.kitchenStatus === 'READY') &&
    !(override && auth.permissions.has('orders.cancel')) &&
    (await loadOrderSettings(tx, auth.tenantId)).cancelPreparingNeedsAck;

  /**
   * Changes quantity or note of an item. Before sending it is edited in place; after
   * sending the old line is cancelled and a new one added, so the kitchen gets a
   * "DIQQAT! CHEK YANGILANDI" ticket with the old line crossed out.
   */
  router.patch(
    '/orders/:id/items/:itemId',
    requireAuth(),
    requirePermission('orders.create'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const itemId = parse(z.uuid(), req.params.itemId);
      const input = parse(
        z
          .object({
            quantity: z.number().int().min(1).max(999).optional(),
            note: z.string().trim().max(200).nullable().optional(),
            reason: z.string().trim().max(200).default(''),
            override: z.boolean().default(false),
          })
          .refine(
            (value) => value.quantity !== undefined || value.note !== undefined,
          ),
        req.body,
      );
      let placedChange = false;
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const item = await tx.orderItem.findFirst({
          where: { id: itemId, orderId: id, status: 'ACTIVE' },
        });
        if (!item) throw errors.notFound();
        const quantity = input.quantity ?? item.quantity;
        const note = input.note !== undefined ? input.note || null : item.note;
        if (order.status === 'DRAFT' || !item.kitchenPrintedAt) {
          await tx.orderItem.update({
            where: { id: itemId },
            data: {
              quantity,
              note,
              lineTotal: (item.unitPrice + item.modifiersTotal) * quantity,
            },
          });
          if (order.status !== 'DRAFT') {
            await tx.order.update({
              where: { id },
              data: { version: { increment: 1 } },
            });
            placedChange = true;
          }
        } else {
          await assertCanEditPlaced(tx, auth, order);
          if (quantity < item.quantity) await assertCanCancelPlaced(tx, auth);
          if (input.reason.length < 3)
            throw errors.validation([{ path: 'reason' }]);
          if (await needsKitchenAck(tx, auth, item, input.override))
            throw new AppError(409, 'ITEM_IN_PREPARATION', 'itemInPreparation');
          await tx.orderItem.update({
            where: { id: itemId },
            data: { status: 'CANCELLED', cancelReason: input.reason },
          });
          const { id: _old, createdAt: _at, ...copy } = item;
          await tx.orderItem.create({
            data: {
              ...copy,
              modifiers: item.modifiers as Prisma.InputJsonValue,
              components: item.components as Prisma.InputJsonValue,
              quantity,
              note,
              lineTotal: (item.unitPrice + item.modifiersTotal) * quantity,
              status: 'ACTIVE',
              kitchenStatus: 'QUEUED',
              prepStartedAt: null,
              readyAt: null,
              kitchenPrintedAt: null,
              cancelPrintedAt: null,
              cancelReason: null,
              cancelRequestedAt: null,
              cancelRequestedById: null,
              cancelRequestReason: null,
              createdById: auth.userId,
            },
          });
          placedChange = true;
          await audit(tx, req, {
            tenantId: auth.tenantId,
            branchId: order.branchId,
            actorUserId: auth.userId,
            action: 'order.item.change',
            entityType: 'order',
            entityId: id,
            data: {
              itemId,
              from: { quantity: item.quantity, note: item.note },
              to: { quantity, note },
              reason: input.reason,
            },
          });
        }
        await recalculate(tx, id);
        await syncKitchenStatus(tx, id, now());
        await addEvent(tx, auth.tenantId, id, auth.userId, 'item_changed', {
          itemId,
          from: { quantity: item.quantity, note: item.note },
          to: { quantity, note },
          ...(input.reason ? { reason: input.reason } : {}),
        });
      });
      res.json(await respondChanged(auth, id, placedChange));
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
      const { reason, override } = parse(
        z.object({
          reason: z.string().trim().max(200).default(''),
          override: z.boolean().default(false),
        }),
        req.body,
      );
      let requested = false;
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        // Items already sent to the kitchen need edit rights and a reason.
        if (order.status !== 'DRAFT') {
          await assertCanEditPlaced(tx, auth, order);
          await assertCanCancelPlaced(tx, auth);
          if (reason.length < 3) throw errors.validation([{ path: 'reason' }]);
        }
        const item = await tx.orderItem.findFirst({
          where: { id: itemId, orderId: id, status: 'ACTIVE' },
        });
        if (!item) throw errors.notFound();
        if (await needsKitchenAck(tx, auth, item, override)) {
          await tx.orderItem.update({
            where: { id: itemId },
            data: {
              cancelRequestedAt: now(),
              cancelRequestedById: auth.userId,
              cancelRequestReason: reason,
            },
          });
          await tx.order.update({
            where: { id },
            data: { version: { increment: 1 } },
          });
          await addEvent(
            tx,
            auth.tenantId,
            id,
            auth.userId,
            'item_cancel_requested',
            { itemId, reason },
          );
          requested = true;
          return;
        }
        await tx.orderItem.update({
          where: { id: itemId },
          data: { status: 'CANCELLED', cancelReason: reason || null },
        });
        await recalculate(tx, id);
        await syncKitchenStatus(tx, id, now());
        await addEvent(tx, auth.tenantId, id, auth.userId, 'item_cancelled', {
          itemId,
          reason,
          ...(override ? { override: true } : {}),
        });
        if (order.status !== 'DRAFT')
          await audit(tx, req, {
            tenantId: auth.tenantId,
            branchId: order.branchId,
            actorUserId: auth.userId,
            action: 'order.item.cancel',
            entityType: 'order',
            entityId: id,
            data: {
              itemId,
              reason,
              lineTotal: item.lineTotal,
              ...(override ? { override: true } : {}),
            },
          });
      });
      const changed = await respondChanged(auth, id, true);
      res.status(requested ? 202 : 200).json({
        ...changed,
        ...(requested ? { cancelRequested: true } : {}),
      });
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
          deliveryLandmark: z.string().trim().max(200).nullable().optional(),
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
        if (input.deliveryLandmark !== undefined)
          data.deliveryLandmark = input.deliveryLandmark;
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
      // Cashier confirmation: staff without approval rights send the order to the
      // cashier first; it reaches the kitchen only after approval.
      const status =
        to === 'PLACED'
          ? await placementStatus(tx, auth.tenantId, auth.permissions)
          : to;
      await tx.order.update({
        where: { id },
        data: {
          status,
          version: { increment: 1 },
          ...(to === 'PLACED' ? { placedAt: now() } : { completedAt: now() }),
        },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
        from: order.status,
        to: status,
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
        // Every line is cancelled so the kitchen receives a "BEKOR" ticket for what
        // it already printed. Stock is only consumed on completion: nothing to reverse.
        await tx.orderItem.updateMany({
          where: { orderId: id, status: 'ACTIVE' },
          data: { status: 'CANCELLED', cancelReason: reason },
        });
        await tx.order.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now(),
            cancelReason: reason,
            version: { increment: 1 },
          },
        });
        await emitWebhook(tx, auth.tenantId, 'order.cancelled', {
          id,
          reason,
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
              'QR',
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
          if (input.method === 'QR') {
            const profile = await tx.tenantProfile.findUnique({
              where: { tenantId: auth.tenantId },
            });
            const qr = qrPaymentOf(profile?.qrPayment);
            if (!qr.enabled)
              throw new AppError(
                400,
                'PROVIDER_NOT_CONFIGURED',
                'providerNotConfigured',
              );
            if (qr.requireReference && !input.reference?.trim())
              throw errors.validation([{ path: 'reference' }]);
          }
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
        db.branch.findUniqueOrThrow({
          where: { id: order.branchId },
          include: { brand: true },
        }),
        order.createdById
          ? db.user.findUnique({
              where: { id: order.createdById },
              select: { displayName: true },
            })
          : null,
      ]);
      const data = serialize(order, { ...auth, permissions: new Set() });
      res.json({
        // A branch trading under a brand prints the brand name and texts.
        business: {
          name: branch.brand?.name ?? tenant.name,
          brand: branch.brand
            ? {
                logoUrl: branch.brand.logoUrl,
                primaryColor: branch.brand.primaryColor,
              }
            : null,
          legalName: tenant.profile?.legalName ?? null,
          taxId: tenant.profile?.taxId ?? null,
          phone: tenant.profile?.phone ?? null,
          header:
            branch.brand?.receiptHeader ??
            tenant.profile?.receiptHeader ??
            null,
          footer:
            branch.brand?.receiptFooter ??
            tenant.profile?.receiptFooter ??
            null,
        },
        branch: {
          name: branch.name,
          address: branch.address,
          phone: branch.phone,
        },
        cashier: cashier?.displayName ?? null,
        layout: receiptSettingsOf(tenant.profile?.receiptSettings),
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
