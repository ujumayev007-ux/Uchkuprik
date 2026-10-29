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
import { qrPaymentOf } from '../settings/settings.routes.js';
import { resolveTemplate } from '../../printing/resolve-template.js';
import { localDateTime, receiptTicket } from '../../printing/receipt.js';
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
import {
  approvalStatus,
  requiredBeforeKitchen,
  type OrderWorkflow,
} from '../workflow/engine.js';
import { isWaiter, orderFlow, snapshotFor } from '../workflow/restaurant.js';

/** Under a workflow, the kitchen gets the order only when the money it asks for is in. */
const assertPaidForKitchen = (
  flow: OrderWorkflow | null,
  total: number,
  paid: number,
) => {
  if (!flow || paid >= requiredBeforeKitchen(flow, total)) return;
  throw flow.payment === 'PREPAY'
    ? new AppError(409, 'WORKFLOW_PAYMENT_FIRST', 'workflowPaymentFirst')
    : new AppError(409, 'WORKFLOW_ADVANCE', 'workflowAdvance', {
        percent: flow.advancePercent,
      });
};
// The kitchen needs no confirmation in this zone: the ticket counts as accepted.
const autoAccept = (flow: OrderWorkflow | null, status: string, at: Date) =>
  flow && !flow.kitchenConfirm && status === 'PLACED'
    ? { kitchenAcceptedAt: at }
    : {};
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

// The central policy switched this order action off for the user's role.
const featureOff = () =>
  new AppError(403, 'FEATURE_DISABLED', 'featureDisabled');

// Methods accepted at the counter. Online providers (Click, Payme, Uzum) are only
// accepted through verified provider callbacks (Phase 8), never as manual entries.
// QR is a merchant QR (e.g. Paynet) confirmed by the cashier; it must be enabled by the owner.
const counterMethods = ['CASH', 'CARD', 'LOYALTY', 'QR'] as const;

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { items: true; payments: true; refunds: true; table: true };
}>;

function serialize(order: OrderWithRelations, auth: AuthContext) {
  const showCost =
    auth.permissions.has('finance.view') &&
    auth.financial.cost &&
    auth.reportFields.cost;
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
    kitchen: {
      acceptedAt: order.kitchenAcceptedAt,
      rejectedAt: order.kitchenRejectedAt,
      rejectReason: order.kitchenRejectReason,
    },
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

  /**
   * A table keeps one active order (unless the restaurant switched that off): the
   * order is restored when the table is reopened, so a second copy is refused. Paid-up
   * and empty orders do not block. Serialized per table so two devices cannot both win.
   */
  const assertTableFree = async (
    tx: Tx,
    auth: AuthContext,
    tableId: string | null,
    exceptOrderId?: string,
  ) => {
    if (!tableId || !auth.ordering.singleOrderPerTable) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tableId}))`;
    const open = await tx.order.findMany({
      where: {
        tenantId: auth.tenantId,
        tableId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}),
      },
      select: {
        id: true,
        number: true,
        total: true,
        paidTotal: true,
        refundedTotal: true,
      },
    });
    const blocking = open.find(
      (order) => order.total - netPaid(order) > 0 && order.total > 0,
    );
    if (blocking)
      throw new AppError(409, 'TABLE_HAS_ORDER', 'tableHasOrder', {
        orderId: blocking.id,
        number: blocking.number,
      });
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
          // Active orders of one table (reopening a table restores its order).
          tableId: z.uuid().optional(),
          scope: z.enum(['active', 'today', 'all']).default('active'),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          // Order history: business-date range and a search (number, guest name or phone).
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          q: z.string().trim().min(1).max(60).optional(),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const today = businessDate(now(), branch.timezone);
      const orders = await db.order.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          ...(query.tableId ? { tableId: query.tableId } : {}),
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
          ...(query.from || query.to
            ? {
                businessDate: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(query.q
            ? {
                OR: [
                  ...(/^\d{1,9}$/.test(query.q)
                    ? [{ number: Number(query.q) }]
                    : []),
                  {
                    customerName: {
                      contains: query.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  { customerPhone: { contains: query.q } },
                ],
              }
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
      // Order types and the «Mijoz» button are central decisions per role.
      if (!auth.ordering.types[input.type]) throw featureOff();
      if (input.type === 'DINE_IN' && !input.tableId && !auth.ordering.walkin)
        throw featureOff();
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
          await assertTableFree(tx, auth, tableId);
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
          // The SUPER_OWNER's workflow for this zone (null: existing behaviour).
          const flow = await snapshotFor(tx, {
            tenantId: auth.tenantId,
            type: input.type,
            channel: 'POS',
            tableId,
            waiter: isWaiter(auth),
          });
          if (input.place) assertPaidForKitchen(flow, totals.total, 0);
          const placing = input.place
            ? flow
              ? approvalStatus(flow, auth.permissions)
              : await placementStatus(tx, auth.tenantId, auth.permissions)
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
              ...autoAccept(flow, placing, now()),
              ...(flow ? { workflow: flow } : {}),
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
        const created = await respondChanged(auth, id);
        // A guest taken at the cashier without a table: waiters are told to assign one.
        if (input.type === 'DINE_IN' && !created.table)
          services.events?.publish({
            type: 'order.table_needed',
            tenantId: auth.tenantId,
            branchId: created.branchId,
            orderId: created.id,
            number: created.number,
            byUserId: auth.userId,
          });
        res.status(201).json(created);
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
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'order.items.add',
          entityType: 'order',
          entityId: id,
          data: {
            items: priced.map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
            })),
          },
        });
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
    order: { status: string; workflow?: unknown; kitchenAcceptedAt?: Date | null },
  ) => {
    if (order.status === 'DRAFT' || order.status === 'PENDING') return;
    // Under a workflow the zone decides (managers may always change).
    const flow = orderFlow(order);
    if (flow && !auth.permissions.has('orders.cancel')) {
      if (
        flow.edit === 'NONE' ||
        (flow.edit === 'BEFORE_KITCHEN' && order.kitchenAcceptedAt)
      )
        throw new AppError(403, 'WORKFLOW_EDIT', 'workflowEdit');
      return;
    }
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
  const assertCanCancelPlaced = async (
    tx: Tx,
    auth: AuthContext,
    order?: { workflow?: unknown },
  ) => {
    if (auth.permissions.has('orders.cancel')) return;
    const flow = order ? orderFlow(order) : null;
    if (flow) {
      if (flow.cancel === 'STAFF') return;
      throw errors.forbidden();
    }
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
              draft: order.status === 'DRAFT',
            },
          });
        } else {
          await assertCanEditPlaced(tx, auth, order);
          if (quantity < item.quantity)
            await assertCanCancelPlaced(tx, auth, order);
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
          await assertCanCancelPlaced(tx, auth, order);
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
      let tableChange: {
        from: string | null;
        to: string | null;
        number: number;
        branchId: string;
      } | null = null;
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        const data: Prisma.OrderUncheckedUpdateInput = {
          version: { increment: 1 },
        };
        if (input.tableId !== undefined) {
          if (!auth.ordering.tableAssign) throw featureOff();
          if (order.type !== 'DINE_IN' && input.tableId)
            throw errors.validation([{ path: 'tableId' }]);
          data.tableId = await assertTable(
            tx,
            auth,
            order.branchId,
            input.tableId,
          );
          if (data.tableId !== order.tableId)
            await assertTableFree(
              tx,
              auth,
              data.tableId as string | null,
              order.id,
            );
          if (data.tableId !== order.tableId)
            tableChange = {
              from: order.tableId,
              to: data.tableId as string | null,
              number: order.number,
              branchId: order.branchId,
            };
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
        // Every edit of order details keeps what it was before.
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'order.update',
          entityType: 'order',
          entityId: id,
          data: {
            from: {
              tableId: order.tableId,
              note: order.note,
              customerName: order.customerName,
              customerPhone: order.customerPhone,
              deliveryAddress: order.deliveryAddress,
            },
            to: JSON.parse(JSON.stringify(input)),
          },
        });
      });
      const updated = await respondChanged(auth, id);
      announceTable(auth, updated, tableChange);
      res.json(updated);
    },
  );

  /** Waiters and cashiers stop alerting once a table is chosen. */
  const announceTable = (
    auth: AuthContext,
    order: { id: string; number: number; branchId: string },
    change: { from: string | null; to: string | null } | null,
  ) => {
    if (!change) return;
    services.events?.publish({
      type: change.to ? 'order.table_assigned' : 'order.table_needed',
      tenantId: auth.tenantId,
      branchId: order.branchId,
      orderId: order.id,
      number: order.number,
      byUserId: auth.userId,
    });
  };

  /**
   * Chooses or changes the table of an order without recreating it: items, payments
   * and history stay. Cashiers and waiters both use this (when the central policy
   * allows), and every panel and waiter tablet is updated at once.
   */
  router.post('/orders/:id/table', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('orders.edit') &&
      !auth.permissions.has('orders.create') &&
      !auth.permissions.has('payments.accept')
    )
      throw errors.forbidden();
    if (!auth.ordering.tableAssign) throw featureOff();
    const id = parse(z.uuid(), req.params.id);
    const input = parse(z.object({ tableId: z.uuid().nullable() }), req.body);
    let change: { from: string | null; to: string | null } | null = null;
    await mutate(auth, id, async (tx, order) => {
      if (!editableStatuses.includes(order.status))
        throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
      if (order.type !== 'DINE_IN')
        throw new AppError(400, 'TABLE_NOT_NEEDED', 'tableNotNeeded');
      const tableId = await assertTable(
        tx,
        auth,
        order.branchId,
        input.tableId,
      );
      if (tableId === order.tableId) return;
      await assertTableFree(tx, auth, tableId, order.id);
      await tx.order.update({
        where: { id },
        data: { tableId, version: { increment: 1 } },
      });
      change = { from: order.tableId, to: tableId };
      const names = await tx.diningTable.findMany({
        where: {
          tenantId: auth.tenantId,
          id: { in: [order.tableId, tableId].filter((v): v is string => !!v) },
        },
        select: { id: true, name: true },
      });
      const nameOf = (value: string | null) =>
        names.find((row) => row.id === value)?.name ?? null;
      await addEvent(tx, auth.tenantId, id, auth.userId, 'table_assigned', {
        from: nameOf(order.tableId),
        to: nameOf(tableId),
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'order.table.assign',
        entityType: 'order',
        entityId: id,
        data: {
          from: { tableId: order.tableId, name: nameOf(order.tableId) },
          to: { tableId, name: nameOf(tableId) },
        },
      });
    });
    const updated = await respondChanged(auth, id);
    announceTable(auth, updated, change);
    res.json(updated);
  });

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
      // Allowed types and the largest discount are decided centrally, per role.
      const rules = auth.ordering.discount;
      if (input.percentBp > 0 && !rules.percent) throw featureOff();
      if (input.fixed > 0 && !rules.fixed) throw featureOff();
      if (input.percentBp > rules.maxPercentBp || input.fixed > rules.maxFixed)
        throw new AppError(403, 'DISCOUNT_LIMIT', 'discountLimit', {
          maxPercentBp: rules.maxPercentBp,
          maxFixed: rules.maxFixed,
        });
      await mutate(auth, id, async (tx, order) => {
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        // The zone's discount rule (removing a discount is always allowed).
        const flow = orderFlow(order);
        if (flow && (input.percentBp > 0 || input.fixed > 0)) {
          const manager =
            auth.permissions.has('settings.manage') ||
            auth.permissions.has('orders.cancel');
          if (flow.discounts === 'NONE' || (flow.discounts === 'MANAGER' && !manager))
            throw new AppError(403, 'WORKFLOW_DISCOUNT', 'workflowDiscount');
        }
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
          data: {
            ...input,
            discountTotal: updated.discountTotal,
            from: {
              percentBp: order.discountBp,
              fixed: order.discountFixed,
              discountTotal: order.discountTotal,
              reason: order.discountReason,
            },
            total: updated.total,
          },
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
      // cashier first; it reaches the kitchen only after approval. Under a workflow its
      // zone decides (approval rule, money due before the kitchen).
      const flow = orderFlow(order);
      if (to === 'PLACED') assertPaidForKitchen(flow, order.total, netPaid(order));
      const status =
        to === 'PLACED'
          ? flow
            ? approvalStatus(flow, auth.permissions)
            : await placementStatus(tx, auth.tenantId, auth.permissions)
          : to;
      await tx.order.update({
        where: { id },
        data: {
          status,
          ...autoAccept(flow, status, now()),
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
          // Paying a draft sends it to the kitchen (typical fast-food counter flow);
          // under a workflow only once the money its zone asks for is in.
          const flow = orderFlow(order);
          const paidAfter = netPaid(order) + input.amount;
          const placing =
            order.status === 'DRAFT' &&
            (!flow || paidAfter >= requiredBeforeKitchen(flow, order.total));
          const placedStatus = flow
            ? approvalStatus(flow, auth.permissions)
            : 'PLACED';
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
              ...(placing
                ? {
                    status: placedStatus,
                    placedAt: now(),
                    ...autoAccept(flow, placedStatus, now()),
                  }
                : {}),
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
              to: placedStatus,
            });
          // Zone closes the table on payment: a served order fully paid is done.
          if (
            flow?.tableClose === 'ON_PAYMENT' &&
            paidAfter >= order.total &&
            (order.status === 'READY' || order.status === 'SERVED')
          ) {
            const fresh = await tx.order.findUniqueOrThrow({ where: { id } });
            await completeOrder(tx, fresh, auth.userId, now());
          }
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
  const buildReceipt = async (
    auth: AuthContext,
    id: string,
    pick: {
      printerId?: string | undefined;
      templateId?: string | undefined;
      // A receipt really being printed (not a preview): counted for the "NUSXA" mark.
      print?: boolean | undefined;
    },
  ) => {
    const order = await load(auth, id);
    const lastPayment = await db.payment.findFirst({
      where: { tenantId: auth.tenantId, orderId: order.id },
      orderBy: { createdAt: 'desc' },
      select: { createdById: true },
    });
    const [tenant, branch, creator, payer] = await Promise.all([
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
            select: {
              displayName: true,
              roles: { select: { role: { select: { systemKey: true } } } },
            },
          })
        : null,
      lastPayment?.createdById
        ? db.user.findUnique({
            where: { id: lastPayment.createdById },
            select: { displayName: true },
          })
        : null,
    ]);
    // The cashier is who took the payment; the waiter is who opened a waiter's order.
    const waiter = creator?.roles.some((r) => r.role.systemKey === 'waiter')
      ? creator.displayName
      : null;
    // A waiter's unpaid order has no cashier yet (the waiter is not shown as one).
    const cashier = payer ?? (waiter ? null : creator);
    // 0 = the first receipt; 1, 2 … = copies printed again ("NUSXA").
    const copy = pick.print
      ? (
          await db.order.update({
            where: { id: order.id },
            data: { receiptPrints: { increment: 1 } },
            select: { receiptPrints: true },
          })
        ).receiptPrints - 1
      : 0;
    const data = serialize(order, { ...auth, permissions: new Set() });
    return {
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
          branch.brand?.receiptHeader ?? tenant.profile?.receiptHeader ?? null,
        footer:
          branch.brand?.receiptFooter ?? tenant.profile?.receiptFooter ?? null,
      },
      branch: {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        timezone: branch.timezone,
      },
      cashier: cashier?.displayName ?? null,
      waiter,
      copy,
      // Template of the printer (or the one picked), else the restaurant default.
      layout: (
        await resolveTemplate(db, auth.tenantId, {
          kind: 'CUSTOMER',
          printerId: pick.printerId ?? null,
          templateId: pick.templateId ?? null,
        })
      ).settings,
      // Fiscal sign/QR exist only after a certified fiscal provider registers the receipt.
      fiscal: (await db.fiscalReceipt.findUnique({
        where: { orderId: order.id },
        select: { status: true, fiscalSign: true, qrUrl: true },
      })) ?? { status: 'NOT_CONFIGURED', fiscalSign: null, qrUrl: null },
      order: {
        ...data,
        items: data.items.filter((item) => item.status === 'ACTIVE'),
      },
    };
  };

  const receiptQuery = z.object({
    printerId: z.uuid().optional(),
    templateId: z.uuid().optional(),
    // "1" when the receipt page is opened to be printed (counts the copies).
    print: z
      .enum(['1', '0'])
      .optional()
      .transform((value) => value === '1'),
  });

  router.get(
    '/orders/:id/receipt',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const query = parse(receiptQuery, req.query);
      res.json(await buildReceipt(auth, id, query));
    },
  );

  // Receipt printers a cashier may send a receipt to.
  router.get(
    '/receipt-printers',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const { branchId } = parse(
        z.object({ branchId: z.uuid().optional() }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, branchId);
      const printers = await db.printer.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          kind: 'RECEIPT',
          isActive: true,
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, paperWidth: true },
      });
      res.json({ printers });
    },
  );

  // Sends the customer receipt to a receipt printer, laid out by that printer's template.
  router.post(
    '/orders/:id/receipt/print',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          printerId: z.uuid(),
          templateId: z.uuid().optional(),
        }),
        req.body,
      );
      const printer = await db.printer.findFirst({
        where: {
          id: input.printerId,
          tenantId: auth.tenantId,
          kind: 'RECEIPT',
          isActive: true,
        },
      });
      if (!printer) throw errors.notFound();
      const receipt = await buildReceipt(auth, id, {
        printerId: printer.id,
        templateId: input.templateId,
        print: true,
      });
      const typeLabels = {
        DINE_IN: 'Zalda',
        TAKEAWAY: 'Olib ketish',
        DELIVERY: 'Yetkazib berish',
      } as const;
      const methodLabels: Record<string, string> = {
        CASH: 'Naqd',
        CARD: 'Karta',
        LOYALTY: 'Bonus',
        CLICK: 'Click',
        PAYME: 'Payme',
        UZUM: 'Uzum',
        QR: 'QR',
        OTHER: 'Boshqa',
      };
      const order = receipt.order;
      const payload = receiptTicket(
        {
          business: receipt.business,
          branch: receipt.branch,
          cashier: receipt.cashier,
          waiter: receipt.waiter,
          customer: {
            name: order.customerName,
            phone: order.customerPhone,
            address: order.deliveryAddress,
          },
          fiscal: receipt.fiscal,
          copy: receipt.copy,
          number: order.number,
          // The branch's local time (not UTC).
          dateTime: localDateTime(new Date(order.createdAt), receipt.branch.timezone),
          typeLabel: typeLabels[order.type],
          table: order.table?.name ?? null,
          items: order.items.map((item) => ({
            name: `${item.productName}${
              item.variantName === 'Standart' ? '' : ` (${item.variantName})`
            }`,
            modifiers: (item.modifiers as { name: string }[]).map(
              (modifier) => modifier.name,
            ),
            note: item.note,
            quantity: item.quantity,
            unitPrice: item.unitPrice + item.modifiersTotal,
            lineTotal: item.lineTotal,
          })),
          subtotal: order.subtotal,
          discountTotal: order.discountTotal,
          serviceCharge: order.serviceCharge,
          total: order.total,
          payments: order.payments.map((payment) => ({
            label: methodLabels[payment.method] ?? payment.method,
            amount: payment.tendered ?? payment.amount,
            change: payment.change,
          })),
          due: order.due,
        },
        receipt.layout,
      );
      const job = await db.printJob.create({
        data: {
          tenantId: auth.tenantId,
          printerId: printer.id,
          orderId: id,
          kind: 'RECEIPT',
          purpose: 'NEW',
          payload,
        },
      });
      res.status(201).json({ jobId: job.id });
    },
  );

  return router;
}
