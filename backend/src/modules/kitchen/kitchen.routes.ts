import { kitchenTicket } from '../../printing/escpos.js';
import {
  ticketTemplateOf,
  ticketTemplateSchema,
} from '../../printing/template.js';
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
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import {
  addEvent,
  assertTransition,
  businessDate,
  lockOrder,
  recalculate,
  syncKitchenStatus,
} from '../orders/engine.js';

const stationInput = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

const can = (
  auth: AuthContext,
  ...keys: Parameters<AuthContext['permissions']['has']>[0][]
) => keys.some((key) => auth.permissions.has(key));

export function kitchenRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  const notify = async (orderId: string) => {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return;
    await services.afterOrderChange?.(order.id);
    services.events?.publish({
      type: 'kitchen.changed',
      tenantId: order.tenantId,
      branchId: order.branchId,
      orderId,
    });
    services.events?.publish({
      type: 'order.changed',
      tenantId: order.tenantId,
      branchId: order.branchId,
      orderId,
      number: order.number,
      status: order.status,
    });
  };

  router.get('/kitchen/stations', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (!can(auth, 'kitchen.access', 'menu.view', 'menu.manage'))
      throw errors.forbidden();
    const stations = await db.kitchenStation.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({
      stations: stations.map(
        ({ id, name, sortOrder, isActive, ticketTemplate }) => ({
          template: ticketTemplateOf(ticketTemplate),
          id,
          name,
          sortOrder,
          isActive,
        }),
      ),
    });
  });

  router.post(
    '/kitchen/stations',
    requireAuth(),
    requirePermission('menu.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(stationInput, req.body);
      try {
        const station = await db.$transaction(async (tx) => {
          const created = await tx.kitchenStation.create({
            data: { tenantId: auth.tenantId, ...input },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'kitchen.station.create',
            entityType: 'kitchen_station',
            entityId: created.id,
          });
          return created;
        });
        res.status(201).json({ id: station.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  // Department ticket layout and a test print to the department's printers.
  router.put(
    '/kitchen/stations/:id/template',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const template = parse(ticketTemplateSchema, req.body);
      const station = await db.kitchenStation.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!station) throw errors.notFound();
      await db.kitchenStation.update({
        where: { id },
        data: { ticketTemplate: template },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'kitchen.template.update',
        entityType: 'kitchen_station',
        entityId: id,
      });
      res.json(template);
    },
  );

  router.post(
    '/kitchen/stations/:id/test-print',
    requireAuth(),
    requirePermission('settings.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const station = await db.kitchenStation.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { printers: { where: { isActive: true, kind: 'KITCHEN' } } },
      });
      if (!station) throw errors.notFound();
      const layout = ticketTemplateOf(station.ticketTemplate);
      for (const printer of station.printers)
        await db.printJob.create({
          data: {
            tenantId: auth.tenantId,
            printerId: printer.id,
            kind: 'KITCHEN',
            purpose: 'TEST',
            payload: kitchenTicket({
              stationName: station.name,
              number: 123,
              typeLabel: 'Sinov',
              table: 'Stol 5',
              note: 'Sinov cheki',
              priority: 0,
              createdAt: now(),
              timezone: 'Asia/Tashkent',
              waiter: auth.displayName,
              columns: printer.paperWidth === 58 ? 32 : 48,
              template: layout,
              items: [
                {
                  quantity: 2,
                  name: 'Namuna taom',
                  modifiers: [],
                  note: 'Achchiq',
                },
              ],
            }),
          },
        });
      res.json({ printers: station.printers.length });
    },
  );

  router.patch(
    '/kitchen/stations/:id',
    requireAuth(),
    requirePermission('menu.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(stationInput, req.body);
      try {
        const result = await db.kitchenStation.updateMany({
          where: { id, tenantId: auth.tenantId },
          data: input,
        });
        if (result.count === 0) throw errors.notFound();
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'kitchen.station.update',
        entityType: 'kitchen_station',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  // Kitchen display tickets. Kitchen staff never receive prices or costs.
  router.get(
    '/kitchen/tickets',
    requireAuth(),
    requirePermission('kitchen.access'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          stationId: z.uuid().optional(),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const orders = await db.order.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          status: { in: ['PLACED', 'PREPARING', 'READY'] },
        },
        orderBy: [{ priority: 'desc' }, { placedAt: 'asc' }],
        take: 200,
        include: {
          table: { select: { name: true } },
          items: {
            where: {
              status: 'ACTIVE',
              // Items without a station appear on every screen.
              ...(query.stationId
                ? { OR: [{ stationId: query.stationId }, { stationId: null }] }
                : {}),
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      // Waiter/source shown on each ticket (names only, no prices).
      const staff = await db.user.findMany({
        where: {
          tenantId: auth.tenantId,
          id: {
            in: orders
              .map((order) => order.createdById)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true, displayName: true },
      });
      const nameOf = (id: string | null) =>
        staff.find((person) => person.id === id)?.displayName ?? null;
      res.json({
        serverTime: now(),
        tickets: orders
          .filter((order) => order.items.length > 0)
          .map((order) => ({
            orderId: order.id,
            number: order.number,
            type: order.type,
            status: order.status,
            priority: order.priority,
            channel: order.channel,
            waiter: nameOf(order.createdById),
            version: order.version,
            table: order.table?.name ?? null,
            note: order.note,
            placedAt: order.placedAt,
            items: order.items.map((item) => ({
              id: item.id,
              productName: item.productName,
              variantName: item.variantName,
              modifiers: [
                ...(item.modifiers as { name: string }[]).map(
                  (modifier) => modifier.name,
                ),
                // Set contents are listed for the cook.
                ...(
                  item.components as { name: string; quantity: number }[]
                ).map((part) => `${part.quantity}× ${part.name}`),
              ],
              quantity: item.quantity,
              note: item.note,
              stationId: item.stationId,
              kitchenStatus: item.kitchenStatus,
              prepTimeMinutes: item.prepTimeMinutes,
              prepStartedAt: item.prepStartedAt,
              cancelRequested: item.cancelRequestedAt
                ? { reason: item.cancelRequestReason }
                : null,
              readyAt: item.readyAt,
            })),
          })),
      });
    },
  );

  const setItems = async (
    auth: AuthContext,
    orderId: string,
    itemIds: string[] | null,
    stationId: string | undefined,
    status: 'QUEUED' | 'PREPARING' | 'READY',
  ) =>
    db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, orderId);
      await resolveBranch(tx, auth, order.branchId);
      if (!['PLACED', 'PREPARING', 'READY'].includes(order.status))
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      const at = now();
      const where = {
        orderId,
        status: 'ACTIVE' as const,
        kitchenStatus: { not: 'SERVED' as const },
        ...(itemIds ? { id: { in: itemIds } } : {}),
        ...(stationId ? { OR: [{ stationId }, { stationId: null }] } : {}),
      };
      const result = await tx.orderItem.updateMany({
        where,
        data: {
          kitchenStatus: status,
          ...(status === 'PREPARING'
            ? { prepStartedAt: at, readyAt: null }
            : {}),
          ...(status === 'READY' ? { readyAt: at } : {}),
          ...(status === 'QUEUED'
            ? { prepStartedAt: null, readyAt: null }
            : {}),
        },
      });
      if (result.count === 0) throw errors.notFound();
      // Items marked ready without being started get a start time for metrics.
      if (status === 'READY')
        await tx.orderItem.updateMany({
          where: { ...where, prepStartedAt: null },
          data: { prepStartedAt: at },
        });
      await addEvent(tx, auth.tenantId, orderId, auth.userId, 'kitchen', {
        status,
        items: itemIds ?? 'all',
        stationId: stationId ?? null,
      });
      await syncKitchenStatus(tx, orderId, at);
    });

  router.post(
    '/kitchen/items/:id/status',
    requireAuth(),
    requirePermission('kitchen.access'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { status } = parse(
        z.object({ status: z.enum(['QUEUED', 'PREPARING', 'READY']) }),
        req.body,
      );
      const item = await db.orderItem.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!item) throw errors.notFound();
      await setItems(auth, item.orderId, [id], undefined, status);
      await notify(item.orderId);
      res.json({ ok: true });
    },
  );

  // The cook confirms (or refuses) cancelling an item that is already being prepared.
  router.post(
    '/kitchen/items/:id/cancel-request',
    requireAuth(),
    requirePermission('kitchen.access'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { accept } = parse(z.object({ accept: z.boolean() }), req.body);
      const item = await db.orderItem.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!item) throw errors.notFound();
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, item.orderId);
        await resolveBranch(tx, auth, order.branchId);
        const fresh = await tx.orderItem.findFirst({
          where: { id, status: 'ACTIVE', cancelRequestedAt: { not: null } },
        });
        if (!fresh)
          throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
        await tx.orderItem.update({
          where: { id },
          data: accept
            ? {
                status: 'CANCELLED',
                cancelReason: fresh.cancelRequestReason,
                cancelRequestedAt: null,
              }
            : {
                cancelRequestedAt: null,
                cancelRequestedById: null,
                cancelRequestReason: null,
              },
        });
        if (accept) {
          await recalculate(tx, item.orderId);
          await syncKitchenStatus(tx, item.orderId, now());
        } else
          await tx.order.update({
            where: { id: item.orderId },
            data: { version: { increment: 1 } },
          });
        await addEvent(
          tx,
          auth.tenantId,
          item.orderId,
          auth.userId,
          accept ? 'item_cancelled' : 'item_cancel_refused',
          { itemId: id, reason: fresh.cancelRequestReason, byKitchen: true },
        );
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: accept ? 'order.item.cancel' : 'order.item.cancel_refused',
          entityType: 'order',
          entityId: item.orderId,
          data: {
            itemId: id,
            reason: fresh.cancelRequestReason,
            requestedBy: fresh.cancelRequestedById,
            lineTotal: fresh.lineTotal,
          },
        });
      });
      await notify(item.orderId);
      res.json({ ok: true });
    },
  );

  // Bump a whole ticket (optionally one station's part of it).
  router.post(
    '/kitchen/orders/:id/bump',
    requireAuth(),
    requirePermission('kitchen.access'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          status: z.enum(['PREPARING', 'READY']),
          stationId: z.uuid().optional(),
        }),
        req.body,
      );
      await setItems(auth, id, null, input.stationId, input.status);
      await notify(id);
      res.json({ ok: true });
    },
  );

  // Hand-over to the guest or table: READY -> SERVED.
  router.post('/orders/:id/serve', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (!can(auth, 'orders.edit', 'kitchen.access')) throw errors.forbidden();
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, auth.tenantId, id);
      await resolveBranch(tx, auth, order.branchId);
      assertTransition(order.status, 'SERVED');
      await tx.orderItem.updateMany({
        where: { orderId: id, status: 'ACTIVE' },
        data: { kitchenStatus: 'SERVED' },
      });
      await tx.order.update({
        where: { id },
        data: { status: 'SERVED', version: { increment: 1 } },
      });
      await addEvent(tx, auth.tenantId, id, auth.userId, 'status', {
        from: order.status,
        to: 'SERVED',
      });
    });
    await notify(id);
    res.json({ ok: true });
  });

  router.post(
    '/orders/:id/priority',
    requireAuth(),
    requirePermission('orders.edit'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { priority } = parse(
        z.object({ priority: z.union([z.literal(0), z.literal(1)]) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        await tx.order.update({
          where: { id },
          data: { priority, version: { increment: 1 } },
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'priority', {
          priority,
        });
      });
      await notify(id);
      res.json({ ok: true });
    },
  );

  // Customer-facing queue screen: order numbers only.
  router.get('/queue', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (!can(auth, 'orders.view', 'kitchen.access')) throw errors.forbidden();
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const orders = await db.order.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        businessDate: businessDate(now(), branch.timezone),
        status: { in: ['PLACED', 'PREPARING', 'READY'] },
      },
      orderBy: [{ readyAt: 'desc' }, { placedAt: 'asc' }],
      select: { number: true, status: true, readyAt: true },
    });
    res.json({
      branch: { name: branch.name },
      preparing: orders
        .filter((order) => order.status !== 'READY')
        .map((order) => order.number),
      ready: orders
        .filter((order) => order.status === 'READY')
        .map((order) => ({ number: order.number, readyAt: order.readyAt })),
    });
  });

  return router;
}
