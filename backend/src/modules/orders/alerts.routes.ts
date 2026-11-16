import { Router } from 'express';
import type { Services } from '../../context.js';
import { AppError, errors } from '../../http/errors.js';
import { authenticate, getAuth, requireAuth } from '../auth/session.js';

const HEARTBEAT_MS = 20_000;
const REVALIDATE_MS = 60_000;
// Guests taken more than this long ago without a table are not announced again.
const SNAPSHOT_WINDOW_MS = 30 * 60_000;
const OPEN_STATUSES = [
  'DRAFT',
  'PENDING',
  'PLACED',
  'PREPARING',
  'READY',
  'SERVED',
] as const;

/**
 * Live alert stream for waiter tablets (Server-Sent Events). The Android app keeps
 * this connection in a foreground service so a «Mijoz» order without a table is
 * announced in Uzbek even while the screen is off; browsers use the same events over
 * the regular real-time socket. Authentication is the same session cookie as every
 * other request; nothing but order numbers travels here.
 *
 * Events: config (what to play), snapshot (guests still waiting for a table, sent on
 * every connect so a reconnect cannot miss one), walkin, assigned, bye; for the
 * waiter of an order: ready (dishes the kitchen just marked ready) and readySnapshot
 * (ready dishes not picked up yet, on every connect). The device shows each dish once.
 */
// Ready dishes older than this are not re-announced after a reconnect.
const READY_WINDOW_MS = 3 * 60 * 60_000;
export function alertsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  router.get('/live/alerts', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    // Walk-in guests (when switched on) and the ready dishes of one's own orders.
    // Waiters: they take orders but are not the cashier (Kassa sees every order itself).
    const takesOrders = (a: typeof auth) =>
      (a.permissions.has('orders.create') ||
        a.permissions.has('orders.edit')) &&
      !a.permissions.has('pos.access');
    if (!auth.ordering.waiterAlerts.enabled && !takesOrders(auth))
      throw new AppError(403, 'FEATURE_DISABLED', 'featureDisabled');
    let walkins = auth.ordering.waiterAlerts.enabled;
    const branchId = auth.activeBranchId;
    if (!branchId) throw errors.validation([{ path: 'branchId' }]);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const config = (value: typeof auth.ordering.waiterAlerts) =>
      send('config', { ...value, serverTime: now().toISOString() });

    config(auth.ordering.waiterAlerts);
    const waiting = !walkins
      ? []
      : await db.order.findMany({
          where: {
            tenantId: auth.tenantId,
            branchId,
            type: 'DINE_IN',
            tableId: null,
            status: { in: [...OPEN_STATUSES] },
            createdAt: { gte: new Date(now().getTime() - SNAPSHOT_WINDOW_MS) },
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: { id: true, number: true, createdAt: true },
        });
    send('snapshot', {
      orders: waiting.map((order) => ({
        orderId: order.id,
        number: order.number,
        createdAt: order.createdAt.toISOString(),
      })),
    });

    // Ready dishes of this waiter's open orders that nobody picked up yet.
    const ready = await db.orderItem.findMany({
      where: {
        tenantId: auth.tenantId,
        status: 'ACTIVE',
        kitchenStatus: 'READY',
        readyAt: { gte: new Date(now().getTime() - READY_WINDOW_MS) },
        order: {
          branchId,
          createdById: auth.userId,
          status: { in: [...OPEN_STATUSES] },
        },
      },
      orderBy: { readyAt: 'asc' },
      take: 50,
      select: {
        id: true,
        productName: true,
        variantName: true,
        quantity: true,
        order: {
          select: { id: true, number: true, table: { select: { name: true } } },
        },
      },
    });
    send('readySnapshot', {
      items: ready.map((item) => ({
        id: item.id,
        orderId: item.order.id,
        number: item.order.number,
        table: item.order.table?.name ?? null,
        name:
          item.variantName && item.variantName !== 'Standart'
            ? `${item.productName} (${item.variantName})`
            : item.productName,
        quantity: item.quantity,
      })),
    });

    const cookie = req.headers.cookie;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(revalidate);
      unsubscribe?.();
      res.end();
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    const refresh = async () => {
      const result = await authenticate(services, cookie, {
        touch: false,
      }).catch(() => ({ status: 'invalid' as const }));
      if (result.status !== 'ok') {
        send('bye', { reason: 'SESSION' });
        finish();
        return;
      }
      const settings = result.auth.ordering.waiterAlerts;
      if (!settings.enabled && !takesOrders(result.auth)) {
        send('bye', { reason: 'DISABLED' });
        finish();
        return;
      }
      walkins = settings.enabled;
      config(settings);
    };
    const revalidate = setInterval(() => void refresh(), REVALIDATE_MS);

    const unsubscribe = services.events?.subscribe((event) => {
      if (closed) return;
      if (event.type === 'config.changed') {
        if (event.tenantId === auth.tenantId) void refresh();
        return;
      }
      if (event.tenantId !== auth.tenantId) return;
      if (!('branchId' in event) || event.branchId !== branchId) return;
      if (event.type === 'order.items_ready') {
        if (event.waiterId !== auth.userId) return;
        send('ready', {
          orderId: event.orderId,
          number: event.number,
          table: event.table,
          items: event.items,
          allReady: event.allReady,
        });
        return;
      }
      if (!walkins) return;
      if (event.type === 'order.table_needed') {
        // Never alert the person who just took the order.
        if (event.byUserId === auth.userId) return;
        send('walkin', {
          orderId: event.orderId,
          number: event.number,
          createdAt: now().toISOString(),
        });
      } else if (event.type === 'order.table_assigned') {
        send('assigned', { orderId: event.orderId, number: event.number });
      } else if (
        event.type === 'order.changed' &&
        (event.status === 'CANCELLED' || event.status === 'COMPLETED')
      ) {
        send('assigned', { orderId: event.orderId, number: event.number });
      }
    });

    req.on('close', finish);
  });

  return router;
}
