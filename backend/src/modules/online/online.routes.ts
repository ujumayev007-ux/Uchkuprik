import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { entitlementsOf } from '../billing/entitlements.js';
import { notifyOnlineOrder } from '../notifications/hooks.js';
import { emitWebhook } from '../developer/webhooks.js';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { messages } from '../../messages.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAnyPermission,
  requireAuth,
} from '../auth/session.js';
import { netPaid } from '../orders/engine.js';
import { canApprove, requiredBeforeKitchen } from '../workflow/engine.js';
import { orderFlow, snapshotFor } from '../workflow/restaurant.js';
import { resolveBranch } from '../branches/access.js';
import { upsertCustomer } from '../crm/loyalty.js';
import { applyDeliveryZone } from '../delivery/delivery.routes.js';
import {
  addEvent,
  assertTransition,
  businessDate,
  computeTotals,
  itemCreateData,
  lockOrder,
  nextOrderNumber,
  priceItems,
} from '../orders/engine.js';

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/);
const publicItem = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(50),
  modifierOptionIds: z.array(z.uuid()).max(20).default([]),
  note: z.string().trim().max(150).nullable().optional(),
});

function planAllowsOnline(subscription: Parameters<typeof entitlementsOf>[0]) {
  const { features } = entitlementsOf(subscription);
  return features === null || features.includes('online_ordering');
}

/** Public storefront for a tenant: only when online ordering is enabled and the tenant is active. */
async function storefront(db: Db, slug: string) {
  const tenant = await db.tenant.findUnique({
    where: { slug },
    include: {
      profile: true,
      subscription: { include: { plan: true } },
    },
  });
  if (
    !tenant ||
    tenant.kind !== 'BUSINESS' ||
    tenant.status !== 'ACTIVE' ||
    !tenant.profile?.publicOrdering ||
    !planAllowsOnline(tenant.subscription)
  )
    throw errors.notFound();
  return tenant;
}

async function tableByToken(db: Db, token: string) {
  const table = await db.diningTable.findUnique({
    where: { qrToken: token },
    include: { branch: true, room: true },
  });
  if (
    !table ||
    !table.isActive ||
    !table.room.isActive ||
    !table.branch.isActive ||
    table.branch.deletedAt
  )
    throw errors.notFound();
  const tenant = await db.tenant.findUnique({
    where: { id: table.tenantId },
    include: {
      profile: true,
      subscription: { include: { plan: true } },
    },
  });
  if (
    !tenant ||
    tenant.status !== 'ACTIVE' ||
    !tenant.profile?.publicOrdering ||
    !planAllowsOnline(tenant.subscription)
  )
    throw errors.notFound();
  return { table, tenant };
}

/** Customer-facing menu: available items only, never costs or internal identifiers beyond ids. */
export async function publicMenu(
  db: Db | Tx,
  tenantId: string,
  branchId: string,
) {
  const branch = await db.branch.findFirst({
    where: { id: branchId, tenantId },
    select: { brandId: true },
  });
  const brandFilter = {
    OR: [{ brandId: null }, { brandId: branch?.brandId ?? null }],
  };
  const [categories, products, groups] = await Promise.all([
    db.menuCategory.findMany({
      where: { tenantId, isActive: true, ...brandFilter },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    db.product.findMany({
      where: {
        tenantId,
        isActive: true,
        deletedAt: null,
        category: { isActive: true, ...brandFilter },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        variants: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: { branchPrices: { where: { branchId } } },
        },
        modifierGroups: { orderBy: { sortOrder: 'asc' } },
      },
    }),
    db.modifierGroup.findMany({
      where: { tenantId, isActive: true },
      include: {
        options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
      },
    }),
  ]);
  const items = products
    .map((product) => ({
      id: product.id,
      categoryId: product.categoryId,
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
      allergens: product.allergens,
      modifierGroupIds: product.modifierGroups.map((link) => link.groupId),
      variants: product.variants
        .filter((variant) => variant.branchPrices[0]?.isAvailable ?? true)
        .map((variant) => ({
          id: variant.id,
          name: variant.name,
          price: variant.branchPrices[0]?.price ?? variant.price,
        })),
    }))
    .filter((product) => product.variants.length > 0);
  return {
    categories: categories
      .filter((category) =>
        items.some((item) => item.categoryId === category.id),
      )
      .map(({ id, name, parentId }) => ({ id, name, parentId })),
    products: items,
    modifierGroups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      options: group.options.map(({ id, name, price }) => ({
        id,
        name,
        price,
      })),
    })),
  };
}

export function onlineRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const orderLimiter = rateLimit({
    windowMs: 60_000,
    limit: services.limits?.credentialsPerMinute ?? 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });

  router.get('/public/r/:slug', async (req, res) => {
    const slug = parse(
      z.string().trim().toLowerCase().max(40),
      req.params.slug,
    );
    const tenant = await storefront(db, slug);
    const branches = await db.branch.findMany({
      where: { tenantId: tenant.id, isActive: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        brand: {
          select: { name: true, logoUrl: true, primaryColor: true },
        },
      },
    });
    res.json({
      name: tenant.name,
      phone: tenant.profile?.phone ?? null,
      branches,
    });
  });

  router.get('/public/r/:slug/menu', async (req, res) => {
    const slug = parse(
      z.string().trim().toLowerCase().max(40),
      req.params.slug,
    );
    const { branchId } = parse(z.object({ branchId: z.uuid() }), req.query);
    const tenant = await storefront(db, slug);
    const branch = await db.branch.findFirst({
      where: {
        id: branchId,
        tenantId: tenant.id,
        isActive: true,
        deletedAt: null,
      },
    });
    if (!branch) throw errors.notFound();
    const zones = await db.deliveryZone.findMany({
      where: { tenantId: tenant.id, branchId: branch.id, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        fee: true,
        minOrder: true,
        etaMinutes: true,
      },
    });
    res.json({ ...(await publicMenu(db, tenant.id, branch.id)), zones });
  });

  router.get('/public/t/:token', async (req, res) => {
    const token = parse(
      z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
      req.params.token,
    );
    const { table, tenant } = await tableByToken(db, token);
    res.json({
      restaurant: { name: tenant.name },
      branch: { id: table.branch.id, name: table.branch.name },
      table: { name: table.name, room: table.room.name },
      menu: await publicMenu(db, tenant.id, table.branchId),
    });
  });

  // Online order submission. Orders wait for staff approval (PENDING); prices are
  // computed on the server and nothing is paid here.
  router.post('/public/orders', orderLimiter, async (req, res) => {
    const input = parse(
      z.object({
        idempotencyKey: z.string().trim().min(16).max(80),
        source: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('table'),
            token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
          }),
          z.object({
            kind: z.literal('web'),
            slug: z.string().trim().toLowerCase().max(40),
            branchId: z.uuid(),
            type: z.enum(['TAKEAWAY', 'DELIVERY']),
            zoneId: z.uuid().optional(),
          }),
        ]),
        customerName: z.string().trim().min(2).max(80),
        customerPhone: phone.optional(),
        deliveryAddress: z.string().trim().min(5).max(300).optional(),
        note: z.string().trim().max(300).nullable().optional(),
        items: z.array(publicItem).min(1).max(30),
      }),
      req.body,
    );
    let tenantId: string;
    let branchId: string;
    let tableId: string | null = null;
    let type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    let channel: 'QR' | 'WEB';
    if (input.source.kind === 'table') {
      const { table } = await tableByToken(db, input.source.token);
      tenantId = table.tenantId;
      branchId = table.branchId;
      tableId = table.id;
      type = 'DINE_IN';
      channel = 'QR';
    } else {
      const tenant = await storefront(db, input.source.slug);
      const branch = await db.branch.findFirst({
        where: {
          id: input.source.branchId,
          tenantId: tenant.id,
          isActive: true,
          deletedAt: null,
        },
      });
      if (!branch) throw errors.notFound();
      tenantId = tenant.id;
      branchId = branch.id;
      type = input.source.type;
      channel = 'WEB';
      if (!input.customerPhone)
        throw errors.validation([{ path: 'customerPhone' }]);
      if (type === 'DELIVERY' && !input.deliveryAddress)
        throw errors.validation([{ path: 'deliveryAddress' }]);
    }
    const existing = await db.order.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing?.trackingToken) {
      res.status(200).json({
        trackingToken: existing.trackingToken,
        number: existing.number,
      });
      return;
    }
    const branch = await db.branch.findUniqueOrThrow({
      where: { id: branchId },
    });
    try {
      const order = await db.$transaction(async (tx) => {
        const priced = await priceItems(tx, tenantId, branchId, input.items);
        const date = businessDate(now(), branch.timezone);
        const number = await nextOrderNumber(tx, branchId, date);
        const subtotal = priced.reduce((sum, item) => sum + item.lineTotal, 0);
        const profile = await tx.tenantProfile.findUnique({
          where: { tenantId },
        });
        const serviceChargeBp =
          type === 'DINE_IN' ? (profile?.serviceChargeBp ?? 0) : 0;
        const customer = input.customerPhone
          ? await upsertCustomer(
              tx,
              tenantId,
              input.customerPhone,
              input.customerName,
            )
          : null;
        // The SUPER_OWNER's workflow: QR / web orders may be refused by the zone, or go
        // straight to the kitchen when it needs no approval and no money up front.
        const flow = await snapshotFor(tx, {
          tenantId,
          type,
          channel,
          tableId,
          waiter: false,
        });
        const direct =
          !!flow &&
          flow.approval === 'AUTO' &&
          requiredBeforeKitchen(flow, 1) === 0;
        const created = await tx.order.create({
          data: {
            tenantId,
            branchId,
            customerId: customer?.id ?? null,
            number,
            businessDate: date,
            type,
            channel,
            status: direct ? 'PLACED' : 'PENDING',
            ...(direct ? { placedAt: now() } : {}),
            ...(direct && !flow.kitchenConfirm
              ? { kitchenAcceptedAt: now() }
              : {}),
            ...(flow ? { workflow: flow } : {}),
            tableId,
            customerName: input.customerName,
            customerPhone: input.customerPhone ?? null,
            deliveryAddress:
              type === 'DELIVERY' ? (input.deliveryAddress ?? null) : null,
            note: input.note ?? null,
            subtotal,
            serviceChargeBp,
            ...computeTotals({
              subtotal,
              discountBp: 0,
              discountFixed: 0,
              serviceChargeBp,
            }),
            idempotencyKey: input.idempotencyKey,
            trackingToken: randomToken(18),
          },
        });
        await tx.orderItem.createMany({
          data: priced.map((item) =>
            itemCreateData(tenantId, created.id, null, item),
          ),
        });
        // Website delivery uses the branch zones; the zone fee joins the total.
        if (type === 'DELIVERY') {
          const zones = await tx.deliveryZone.count({
            where: { tenantId, branchId, isActive: true },
          });
          const zoneId =
            input.source.kind === 'web' ? input.source.zoneId : undefined;
          if (zones > 0 && !zoneId)
            throw errors.validation([{ path: 'zoneId' }]);
          if (zoneId) await applyDeliveryZone(tx, tenantId, created.id, zoneId);
        }
        await addEvent(tx, tenantId, created.id, null, 'created', {
          status: 'PENDING',
          channel,
          items: priced.length,
        });
        const final = await tx.order.findUniqueOrThrow({
          where: { id: created.id },
          select: { total: true },
        });
        await emitWebhook(tx, tenantId, 'order.online_created', {
          id: created.id,
          number: created.number,
          branchId,
          total: final.total,
        });
        await notifyOnlineOrder(tx, {
          tenantId,
          branchId,
          number: created.number,
          total: final.total,
        });
        return created;
      });
      services.events?.publish({
        type: 'order.changed',
        tenantId,
        branchId,
        orderId: order.id,
        number: order.number,
        status: order.status,
      });
      res
        .status(201)
        .json({ trackingToken: order.trackingToken, number: order.number });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // Customer order tracking by unguessable token.
  router.get('/public/orders/:token', async (req, res) => {
    const token = parse(
      z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
      req.params.token,
    );
    const order = await db.order.findUnique({
      where: { trackingToken: token },
      include: {
        items: { where: { status: 'ACTIVE' } },
        branch: { select: { name: true, phone: true } },
        table: { select: { name: true } },
      },
    });
    if (!order) throw errors.notFound();
    res.json({
      number: order.number,
      status: order.status,
      type: order.type,
      branch: order.branch,
      table: order.table?.name ?? null,
      createdAt: order.createdAt,
      readyAt: order.readyAt,
      cancelReason: order.status === 'CANCELLED' ? order.cancelReason : null,
      items: order.items.map((item) => ({
        name: item.productName,
        variant: item.variantName,
        modifiers: (item.modifiers as { name: string }[]).map(
          (modifier) => modifier.name,
        ),
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      serviceCharge: order.serviceCharge,
      total: order.total,
      paid: order.paidTotal - order.refundedTotal,
    });
  });

  // --- Staff approval of online orders ---------------------------------------

  const decide = async (
    auth: ReturnType<typeof getAuth>,
    id: string,
    approve: boolean,
    reason: string | null,
  ) => {
    const order = await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      const to = approve ? 'PLACED' : 'CANCELLED';
      if (order.status !== 'PENDING')
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      // Under a workflow the zone says who approves (cashier, waiter or admin).
      const flow = orderFlow(order);
      if (flow) {
        if (!canApprove(flow, auth.permissions))
          throw new AppError(403, 'WORKFLOW_APPROVAL', 'workflowApproval');
        if (approve && netPaid(order) < requiredBeforeKitchen(flow, order.total))
          throw new AppError(409, 'WORKFLOW_PAYMENT_FIRST', 'workflowPaymentFirst');
      } else if (
        // Staff orders waiting for cashier confirmation are approved by the cashier.
        (order.channel === 'POS' || order.channel === 'WAITER') &&
        !auth.permissions.has('payments.accept')
      )
        throw errors.forbidden();
      else if (!auth.permissions.has('orders.approve')) throw errors.forbidden();
      assertTransition(order.status, to);
      const updated = await tx.order.update({
        where: { id },
        data: approve
          ? {
              status: 'PLACED',
              placedAt: now(),
              ...(flow && !flow.kitchenConfirm ? { kitchenAcceptedAt: now() } : {}),
              // Waiter orders keep their waiter; online orders get the approver.
              createdById: order.createdById ?? auth.userId,
              version: { increment: 1 },
            }
          : {
              status: 'CANCELLED',
              cancelledAt: now(),
              cancelReason: reason,
              version: { increment: 1 },
            },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
        from: 'PENDING',
        to,
        ...(reason ? { reason } : {}),
      });
      return updated;
    });
    await services.afterOrderChange?.(order.id);
    services.events?.publish({
      type: 'order.changed',
      tenantId: order.tenantId,
      branchId: order.branchId,
      orderId: order.id,
      number: order.number,
      status: order.status,
    });
    return order;
  };

  router.post(
    '/orders/:id/approve',
    requireAuth(),
    // The order's own rule is checked in decide() (a waiter may approve QR orders).
    requireAnyPermission('orders.approve', 'orders.create', 'settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const order = await decide(
        auth,
        parse(z.uuid(), req.params.id),
        true,
        null,
      );
      res.json({ id: order.id, status: order.status });
    },
  );

  router.post(
    '/orders/:id/reject',
    requireAuth(),
    requireAnyPermission('orders.approve', 'orders.create', 'settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const { reason } = parse(
        z.object({ reason: z.string().trim().min(3).max(200) }),
        req.body,
      );
      const order = await decide(
        auth,
        parse(z.uuid(), req.params.id),
        false,
        reason,
      );
      await audit(db, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'order.reject',
        entityType: 'order',
        entityId: order.id,
        data: { reason },
      });
      res.json({ id: order.id, status: order.status });
    },
  );

  return router;
}
