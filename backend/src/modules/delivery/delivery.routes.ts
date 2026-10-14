import {
  applyDeliveryLocation,
  deliveryPricingOf,
  deliveryPricingSchema,
  latitude,
  longitude,
} from './distance.js';
import { issueOrderCode, verifyOrderCode } from '../orders/codes.js';
import { loadOrderSettings } from '../orders/settings.js';
import { telegramApi } from '../telegram/bot.js';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
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
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { completeOrder } from '../orders/complete.js';
import {
  addEvent,
  assertTransition,
  editableStatuses,
  lockOrder,
  netPaid,
  recalculate,
} from '../orders/engine.js';

const LOCATION_FRESH_MS = 10 * 60_000;
const zoneInput = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(2).max(60),
  fee: z.number().int().min(0).max(10_000_000),
  minOrder: z.number().int().min(0).max(100_000_000).default(0),
  etaMinutes: z.number().int().min(1).max(600).nullable().optional(),
  isActive: z.boolean().default(true),
});

/** Sets an order's delivery zone and fee; the zone minimum applies to the subtotal. */
export async function applyDeliveryZone(
  tx: Tx,
  tenantId: string,
  orderId: string,
  zoneId: string | null,
) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.type !== 'DELIVERY') throw errors.validation([{ path: 'zoneId' }]);
  let fee = 0;
  if (zoneId) {
    const zone = await tx.deliveryZone.findFirst({
      where: { id: zoneId, tenantId, branchId: order.branchId, isActive: true },
    });
    if (!zone) throw errors.validation([{ path: 'zoneId' }]);
    if (order.subtotal < zone.minOrder)
      throw new AppError(400, 'ZONE_MIN_ORDER', 'zoneMinOrder', {
        minOrder: zone.minOrder,
      });
    fee = zone.fee;
  }
  await tx.order.update({
    where: { id: orderId },
    data: { deliveryZoneId: zoneId, deliveryFee: fee },
  });
  return recalculate(tx, orderId);
}

export function deliveryRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [requireAuth(), requirePermission('delivery.manage')];
  const courier = [requireAuth(), requirePermission('delivery.courier')];

  const notify = async (orderId: string) => {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    await services.afterOrderChange?.(order.id);
    services.events?.publish({
      type: 'order.changed',
      tenantId: order.tenantId,
      branchId: order.branchId,
      orderId,
      number: order.number,
      status: order.status,
    });
  };

  // --- Zones -----------------------------------------------------------------

  router.get('/delivery/zones', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('delivery.manage') &&
      !auth.permissions.has('orders.create')
    )
      throw errors.forbidden();
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const zones = await db.deliveryZone.findMany({
      where: { tenantId: auth.tenantId, branchId: branch.id },
      orderBy: { name: 'asc' },
    });
    res.json({ zones });
  });

  router.post('/delivery/zones', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(zoneInput, req.body);
    await resolveBranch(db, auth, input.branchId);
    try {
      const zone = await db.deliveryZone.create({
        data: {
          tenantId: auth.tenantId,
          ...input,
          etaMinutes: input.etaMinutes ?? null,
        },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        branchId: input.branchId,
        actorUserId: auth.userId,
        action: 'delivery.zone.create',
        entityType: 'delivery_zone',
        entityId: zone.id,
      });
      res.status(201).json({ id: zone.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/delivery/zones/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(zoneInput, req.body);
    await resolveBranch(db, auth, input.branchId);
    try {
      const result = await db.deliveryZone.updateMany({
        where: { id, tenantId: auth.tenantId },
        data: { ...input, etaMinutes: input.etaMinutes ?? null },
      });
      if (result.count === 0) throw errors.notFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  // --- Dispatch ----------------------------------------------------------------

  router.post(
    '/orders/:id/delivery-zone',
    requireAuth(),
    requirePermission('orders.edit'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { zoneId } = parse(
        z.object({ zoneId: z.uuid().nullable() }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        await applyDeliveryZone(tx, auth.tenantId, id, zoneId);
        await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery_zone', {
          zoneId,
        });
      });
      await notify(id);
      res.json({ ok: true });
    },
  );

  const couriersFor = async (auth: AuthContext, branchId: string) =>
    db.user.findMany({
      where: {
        tenantId: auth.tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        // Courier roles only: owners/admins hold every permission but are not couriers.
        roles: {
          some: {
            role: {
              permissions: { has: 'delivery.courier' },
              OR: [
                { systemKey: null },
                { systemKey: { notIn: ['owner', 'admin'] } },
              ],
            },
          },
        },
        OR: [{ allBranches: true }, { branches: { some: { branchId } } }],
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });

  router.post('/orders/:id/courier', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { courierId } = parse(
      z.object({ courierId: z.uuid().nullable() }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      if (
        order.type !== 'DELIVERY' ||
        ['COMPLETED', 'CANCELLED', 'PENDING', 'DRAFT'].includes(order.status)
      )
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      if (
        order.deliveryStatus === 'DELIVERED' ||
        order.deliveryStatus === 'PICKED_UP'
      )
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      if (
        courierId &&
        !(await couriersFor(auth, order.branchId)).some(
          (user) => user.id === courierId,
        )
      )
        throw errors.validation([{ path: 'courierId' }]);
      await tx.order.update({
        where: { id },
        data: courierId
          ? {
              courierId,
              deliveryStatus: 'ASSIGNED',
              assignedAt: now(),
              deliveryFailReason: null,
              version: { increment: 1 },
            }
          : {
              courierId: null,
              deliveryStatus: 'UNASSIGNED',
              assignedAt: null,
              version: { increment: 1 },
            },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'courier', {
        courierId,
      });
    });
    await notify(id);
    res.json({ ok: true });
  });

  // Manager board: active delivery orders, couriers and their consented positions.
  router.get('/delivery/board', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const [orders, couriers, zones] = await Promise.all([
      db.order.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          type: 'DELIVERY',
          status: { in: ['PLACED', 'PREPARING', 'READY', 'SERVED'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
      couriersFor(auth, branch.id),
      db.deliveryZone.findMany({
        where: { tenantId: auth.tenantId, branchId: branch.id },
      }),
    ]);
    const profiles = await db.courierProfile.findMany({
      where: { userId: { in: couriers.map((c) => c.id) } },
    });
    const fresh = (profile: (typeof profiles)[number] | undefined) =>
      profile?.locationConsent &&
      profile.locationAt &&
      now().getTime() - profile.locationAt.getTime() < LOCATION_FRESH_MS;
    res.json({
      orders: orders.map((order) => ({
        id: order.id,
        number: order.number,
        status: order.status,
        deliveryStatus: order.deliveryStatus ?? 'UNASSIGNED',
        courierId: order.courierId,
        zone:
          zones.find((zone) => zone.id === order.deliveryZoneId)?.name ?? null,
        address: order.deliveryAddress,
        landmark: order.deliveryLandmark,
        lat: order.deliveryLat,
        lng: order.deliveryLng,
        distanceM: order.deliveryDistanceM,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        total: order.total,
        due: order.total - netPaid(order),
        createdAt: order.createdAt,
        failReason: order.deliveryFailReason,
        cashCollected: order.cashCollected,
        cashReconciled: !!order.cashReconciledAt,
        telegram: !!order.telegramChatId,
      })),
      couriers: couriers.map((user) => {
        const profile = profiles.find((item) => item.userId === user.id);
        return {
          id: user.id,
          name: user.displayName,
          active: orders.filter(
            (order) =>
              order.courierId === user.id &&
              order.deliveryStatus !== 'DELIVERED',
          ).length,
          location: fresh(profile)
            ? { lat: profile!.lat, lng: profile!.lng, at: profile!.locationAt }
            : null,
        };
      }),
    });
  });

  // --- Courier screen -----------------------------------------------------------

  router.get('/courier/orders', ...courier, async (_req, res) => {
    const auth = getAuth(res);
    const orders = await db.order.findMany({
      where: {
        tenantId: auth.tenantId,
        courierId: auth.userId,
        OR: [
          {
            deliveryStatus: {
              in: ['ASSIGNED', 'PICKED_UP', 'ON_THE_WAY', 'FAILED'],
            },
          },
          { deliveredAt: { gte: new Date(now().getTime() - 12 * 3_600_000) } },
        ],
      },
      orderBy: { assignedAt: 'asc' },
      include: { items: { where: { status: 'ACTIVE' } } },
    });
    const profile = await db.courierProfile.findUnique({
      where: { userId: auth.userId },
    });
    res.json({
      locationConsent: profile?.locationConsent ?? false,
      // Couriers see what they must deliver and collect, not internal costs.
      orders: orders.map((order) => ({
        id: order.id,
        number: order.number,
        status: order.status,
        deliveryStatus: order.deliveryStatus,
        address: order.deliveryAddress,
        landmark: order.deliveryLandmark,
        lat: order.deliveryLat,
        lng: order.deliveryLng,
        distanceM: order.deliveryDistanceM,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        note: order.note,
        total: order.total,
        due: order.total - netPaid(order),
        cashCollected: order.cashCollected,
        items: order.items.map((item) => ({
          name: item.productName,
          quantity: item.quantity,
        })),
        deliveredAt: order.deliveredAt,
      })),
    });
  });

  const courierAction = async (
    auth: AuthContext,
    id: string,
    fn: (tx: Tx, order: Awaited<ReturnType<typeof lockOrder>>) => Promise<void>,
  ) => {
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      // Couriers may only act on orders assigned to them.
      if (order.courierId !== auth.userId) throw errors.notFound();
      await fn(tx, order);
    });
    await notify(id);
  };

  // --- GPS and distance pricing ------------------------------------------------

  router.get('/delivery/pricing', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const profile = await db.tenantProfile.findUnique({
      where: { tenantId: auth.tenantId },
    });
    res.json({
      pricing: deliveryPricingOf(profile?.deliveryPricing),
      branch: { id: branch.id, lat: branch.lat, lng: branch.lng },
    });
  });

  router.put('/delivery/pricing', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        pricing: deliveryPricingSchema,
        branch: z
          .object({
            id: z.uuid(),
            lat: latitude.nullable(),
            lng: longitude.nullable(),
          })
          .optional(),
      }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      if (input.branch) {
        const branch = await resolveBranch(tx, auth, input.branch.id);
        await tx.branch.update({
          where: { id: branch.id },
          data: { lat: input.branch.lat, lng: input.branch.lng },
        });
      }
      await tx.tenantProfile.upsert({
        where: { tenantId: auth.tenantId },
        update: { deliveryPricing: input.pricing },
        create: { tenantId: auth.tenantId, deliveryPricing: input.pricing },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'delivery.pricing.update',
        data: { pricing: input.pricing, branch: input.branch ?? null },
      });
    });
    res.json({ ok: true });
  });

  // Customer point (GPS or map link) on a delivery order; recomputes the fee.
  router.post(
    '/orders/:id/delivery-location',
    requireAuth(),
    async (req, res) => {
      const auth = getAuth(res);
      if (
        !auth.permissions.has('delivery.manage') &&
        !auth.permissions.has('orders.create')
      )
        throw errors.forbidden();
      const id = parse(z.uuid(), req.params.id);
      const point = parse(
        z.object({ lat: latitude, lng: longitude }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (!editableStatuses.includes(order.status))
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        await applyDeliveryLocation(tx, auth.tenantId, id, point);
        await addEvent(
          tx,
          auth.tenantId,
          id,
          auth.userId,
          'delivery_location',
          {},
        );
      });
      await notify(id);
      const fresh = await db.order.findUniqueOrThrow({ where: { id } });
      res.json({
        deliveryFee: fresh.deliveryFee,
        distanceM: fresh.deliveryDistanceM,
        total: fresh.total,
      });
    },
  );

  // --- Two-stage verification (cashier -> courier -> customer) ----------------

  const deliveryTransitions: Record<string, string[]> = {
    UNASSIGNED: ['ASSIGNED'],
    ASSIGNED: ['ASSIGNED', 'UNASSIGNED', 'PICKED_UP', 'FAILED'],
    PICKED_UP: ['ON_THE_WAY', 'DELIVERED', 'FAILED'],
    ON_THE_WAY: ['DELIVERED', 'FAILED'],
    FAILED: ['ASSIGNED', 'PICKED_UP', 'RETURNED', 'DELIVERED'],
    DELIVERED: [],
    RETURNED: [],
  };
  const assertDelivery = (from: string | null, to: string) => {
    if (!(deliveryTransitions[from ?? 'UNASSIGNED'] ?? []).includes(to))
      throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition', {
        from,
        to,
      });
  };
  const codesRequired = async (tx: Tx, tenantId: string) =>
    (await loadOrderSettings(tx, tenantId)).deliveryCodes;

  // Stage 1a: the courier asks for a handoff code and shows it to the cashier.
  router.post(
    '/courier/orders/:id/handoff-code',
    ...courier,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      let issued: { code: string; expiresAt: Date } | null = null;
      await courierAction(auth, id, async (tx, order) => {
        assertDelivery(order.deliveryStatus, 'PICKED_UP');
        if (order.status !== 'READY' && order.status !== 'SERVED')
          throw new AppError(409, 'ORDER_NOT_READY', 'orderNotReady');
        issued = await issueOrderCode(tx, services.secrets, {
          tenantId: auth.tenantId,
          orderId: id,
          purpose: 'HANDOFF',
          actorId: auth.userId,
          now: now(),
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'handoff_code', {});
      });
      res.json(issued);
    },
  );

  // Stage 1b: the cashier enters the courier's code -> "Kuryerga topshirildi".
  router.post('/delivery/orders/:id/handoff', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { code } = parse(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
      }),
      req.body,
    );
    // Wrong codes still commit their attempt count (no throw inside the transaction).
    const result = await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      if (order.type !== 'DELIVERY' || !order.courierId)
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      assertDelivery(order.deliveryStatus, 'PICKED_UP');
      if (order.status !== 'READY' && order.status !== 'SERVED')
        throw new AppError(409, 'ORDER_NOT_READY', 'orderNotReady');
      const check = await verifyOrderCode(tx, services.secrets, {
        orderId: id,
        purpose: 'HANDOFF',
        code,
        now: now(),
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'handoff_check', {
        ok: check.ok,
      });
      if (!check.ok) return check;
      await tx.order.update({
        where: { id },
        data: {
          deliveryStatus: 'PICKED_UP',
          pickedUpAt: now(),
          handedOverById: auth.userId,
          status: 'SERVED',
          deliveryFailReason: null,
          version: { increment: 1 },
        },
      });
      await tx.orderItem.updateMany({
        where: { orderId: id, status: 'ACTIVE' },
        data: { kitchenStatus: 'SERVED' },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
        status: 'PICKED_UP',
        courierId: order.courierId,
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'delivery.handoff',
        entityType: 'order',
        entityId: id,
        data: { courierId: order.courierId },
      });
      return check;
    });
    if (!result.ok)
      throw new AppError(400, 'CODE_INVALID', 'codeInvalid', {
        attemptsLeft: Math.max(0, result.attemptsLeft),
      });
    await notify(id);
    res.json({ ok: true });
  });

  // Customer delivery code for non-Telegram customers (or a fresh one): sent to the
  // Telegram chat when there is one, otherwise shown once to the cashier to phone
  // the customer. Never returned to couriers.
  router.post(
    '/delivery/orders/:id/customer-code',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (
          order.type !== 'DELIVERY' ||
          ['DELIVERED', 'RETURNED'].includes(order.deliveryStatus ?? '')
        )
          throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
        const issued = await issueOrderCode(tx, services.secrets, {
          tenantId: auth.tenantId,
          orderId: id,
          purpose: 'DELIVERY',
          actorId: auth.userId,
          now: now(),
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'delivery.code.issue',
          entityType: 'order',
          entityId: id,
          data: { telegram: !!order.telegramChatId },
        });
        return { ...issued, order };
      });
      if (result.order.telegramChatId) {
        const bot = await db.telegramConfig.findUnique({
          where: { tenantId: auth.tenantId },
        });
        if (bot?.isActive) {
          await telegramApi(
            services,
            services.secrets.decrypt(bot.botTokenEnc),
            'sendMessage',
            {
              chat_id: result.order.telegramChatId,
              text: `🔐 Buyurtma №${result.order.number} uchun tasdiq kodi: ${result.code}\nKodni faqat kuryer buyurtmani topshirganda ayting.`,
            },
          );
          res.json({ sent: 'telegram' });
          return;
        }
      }
      res.json({ code: result.code, expiresAt: result.expiresAt });
    },
  );

  router.post(
    '/courier/orders/:id/on-the-way',
    ...courier,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await courierAction(auth, id, async (tx, order) => {
        assertDelivery(order.deliveryStatus, 'ON_THE_WAY');
        await tx.order.update({
          where: { id },
          data: {
            deliveryStatus: 'ON_THE_WAY',
            onTheWayAt: now(),
            version: { increment: 1 },
          },
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
          status: 'ON_THE_WAY',
        });
      });
      res.json({ ok: true });
    },
  );

  // Cash the courier brought back is checked by the cashier before it is booked.
  router.post('/delivery/orders/:id/reconcile', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { amount } = parse(
      z.object({ amount: z.number().int().min(1).max(1_000_000_000) }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      if (order.cashCollected <= 0 || order.cashReconciledAt)
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      if (amount !== order.cashCollected)
        throw new AppError(409, 'CASH_MISMATCH', 'cashMismatch', {
          expected: order.cashCollected,
        });
      await tx.order.update({
        where: { id },
        data: {
          cashReconciledAt: now(),
          cashReconciledById: auth.userId,
          version: { increment: 1 },
        },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'cash_reconciled', {
        amount,
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'delivery.cash.reconcile',
        entityType: 'order',
        entityId: id,
        data: { amount, courierId: order.courierId },
      });
    });
    await notify(id);
    res.json({ ok: true });
  });

  // Authorized manual exceptions (lost code, returned food), always audited.
  router.post('/delivery/orders/:id/exception', ...manage, async (req, res) => {
    const auth = getAuth(res);
    if (!auth.permissions.has('orders.cancel')) throw errors.forbidden();
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        status: z.enum(['DELIVERED', 'FAILED', 'RETURNED']),
        reason: z.string().trim().min(3).max(300),
      }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      if (order.type !== 'DELIVERY')
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      assertDelivery(order.deliveryStatus, input.status);
      await tx.order.update({
        where: { id },
        data: {
          deliveryStatus: input.status,
          ...(input.status === 'DELIVERED'
            ? { deliveredAt: now(), deliveryProof: input.reason }
            : { deliveryFailReason: input.reason }),
          version: { increment: 1 },
        },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
        status: input.status,
        reason: input.reason,
        exception: true,
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'delivery.exception',
        entityType: 'order',
        entityId: id,
        data: {
          from: order.deliveryStatus,
          to: input.status,
          reason: input.reason,
        },
      });
      if (input.status === 'DELIVERED' && netPaid(order) >= order.total) {
        const fresh = await tx.order.findUniqueOrThrow({ where: { id } });
        await completeOrder(tx, fresh, auth.userId, now());
      }
    });
    await notify(id);
    res.json({ ok: true });
  });

  router.post('/courier/orders/:id/pickup', ...courier, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await courierAction(auth, id, async (tx, order) => {
      if (await codesRequired(tx, auth.tenantId))
        throw new AppError(409, 'HANDOFF_REQUIRED', 'handoffRequired');
      if (
        order.deliveryStatus !== 'ASSIGNED' &&
        order.deliveryStatus !== 'FAILED'
      )
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      if (order.status !== 'READY' && order.status !== 'SERVED')
        throw new AppError(409, 'ORDER_NOT_READY', 'orderNotReady');
      if (order.status === 'READY') assertTransition(order.status, 'SERVED');
      await tx.order.update({
        where: { id },
        data: {
          deliveryStatus: 'PICKED_UP',
          pickedUpAt: now(),
          status: 'SERVED',
          deliveryFailReason: null,
          version: { increment: 1 },
        },
      });
      await tx.orderItem.updateMany({
        where: { orderId: id, status: 'ACTIVE' },
        data: { kitchenStatus: 'SERVED' },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
        status: 'PICKED_UP',
      });
    });
    res.json({ ok: true });
  });

  // Delivered: a fully paid order completes; otherwise cash is handed to the cashier.
  router.post('/courier/orders/:id/deliver', ...courier, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        proof: z.string().trim().min(2).max(300).optional(),
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/)
          .optional(),
        // Cash taken from the customer; booked later by the cashier.
        cashCollected: z.number().int().min(0).max(1_000_000_000).default(0),
      }),
      req.body,
    );
    const proof = input.proof ?? null;
    let completed = false;
    let wrong: { attemptsLeft: number } | null = null;
    await courierAction(auth, id, async (tx, order) => {
      if (
        order.deliveryStatus !== 'PICKED_UP' &&
        order.deliveryStatus !== 'ON_THE_WAY'
      )
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      if (await codesRequired(tx, auth.tenantId)) {
        if (!input.code) throw errors.validation([{ path: 'code' }]);
        const check = await verifyOrderCode(tx, services.secrets, {
          orderId: id,
          purpose: 'DELIVERY',
          code: input.code,
          now: now(),
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery_check', {
          ok: check.ok,
        });
        if (!check.ok) {
          wrong = { attemptsLeft: Math.max(0, check.attemptsLeft) };
          return;
        }
      } else if (!proof) throw errors.validation([{ path: 'proof' }]);
      if (input.cashCollected > order.total - netPaid(order))
        throw errors.validation([{ path: 'cashCollected' }]);
      await tx.order.update({
        where: { id },
        data: {
          deliveryStatus: 'DELIVERED',
          deliveredAt: now(),
          deliveryProof: proof,
          cashCollected: input.cashCollected,
        },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
        status: 'DELIVERED',
        proof,
      });
      if (netPaid(order) >= order.total) {
        const fresh = await tx.order.findUniqueOrThrow({ where: { id } });
        await completeOrder(tx, fresh, auth.userId, now());
        completed = true;
      }
    });
    if (wrong) throw new AppError(400, 'CODE_INVALID', 'codeInvalid', wrong);
    res.json({ ok: true, completed });
  });

  router.post('/courier/orders/:id/fail', ...courier, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { reason } = parse(
      z.object({ reason: z.string().trim().min(3).max(300) }),
      req.body,
    );
    await courierAction(auth, id, async (tx, order) => {
      assertDelivery(order.deliveryStatus, 'FAILED');
      await tx.order.update({
        where: { id },
        data: { deliveryStatus: 'FAILED', deliveryFailReason: reason },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'delivery', {
        status: 'FAILED',
        reason,
      });
    });
    res.json({ ok: true });
  });

  // Location sharing is opt-in; withdrawing consent erases the stored position.
  router.put('/courier/consent', ...courier, async (req, res) => {
    const auth = getAuth(res);
    const { consent } = parse(z.object({ consent: z.boolean() }), req.body);
    await db.courierProfile.upsert({
      where: { userId: auth.userId },
      create: {
        userId: auth.userId,
        tenantId: auth.tenantId,
        locationConsent: consent,
        consentAt: consent ? now() : null,
      },
      update: consent
        ? { locationConsent: true, consentAt: now() }
        : {
            locationConsent: false,
            consentAt: null,
            lat: null,
            lng: null,
            accuracy: null,
            locationAt: null,
          },
    });
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: consent
        ? 'courier.location.consent'
        : 'courier.location.withdraw',
    });
    res.json({ ok: true });
  });

  router.post('/courier/location', ...courier, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100_000).optional(),
      }),
      req.body,
    );
    const result = await db.courierProfile.updateMany({
      where: {
        userId: auth.userId,
        tenantId: auth.tenantId,
        locationConsent: true,
      },
      data: {
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy ?? null,
        locationAt: now(),
      },
    });
    if (result.count === 0)
      throw new AppError(403, 'CONSENT_REQUIRED', 'consentRequired');
    res.json({ ok: true });
  });

  // --- Courier performance --------------------------------------------------------

  router.get('/delivery/report', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('delivery.manage') &&
      !auth.permissions.has('reports.view')
    )
      throw errors.forbidden();
    const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const query = parse(
      z.object({ branchId: z.uuid().optional(), from: isoDate, to: isoDate }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(
      new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000,
    );
    const orders = await db.order.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        type: 'DELIVERY',
        courierId: { not: null },
        assignedAt: { gte: from, lt: to },
      },
      select: {
        courierId: true,
        deliveryStatus: true,
        deliveryFee: true,
        assignedAt: true,
        deliveredAt: true,
      },
    });
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(orders.map((o) => o.courierId!))] } },
      select: { id: true, displayName: true },
    });
    res.json({
      couriers: users.map((user) => {
        const mine = orders.filter((order) => order.courierId === user.id);
        const delivered = mine.filter(
          (order) => order.deliveryStatus === 'DELIVERED',
        );
        const minutes = delivered
          .filter((order) => order.assignedAt && order.deliveredAt)
          .map(
            (order) =>
              (order.deliveredAt!.getTime() - order.assignedAt!.getTime()) /
              60_000,
          );
        return {
          courierId: user.id,
          name: user.displayName,
          delivered: delivered.length,
          failed: mine.filter((order) => order.deliveryStatus === 'FAILED')
            .length,
          deliveryFees: delivered.reduce(
            (sum, order) => sum + order.deliveryFee,
            0,
          ),
          averageMinutes: minutes.length
            ? Math.round(
                minutes.reduce((sum, value) => sum + value, 0) / minutes.length,
              )
            : null,
        };
      }),
    });
  });

  return router;
}
