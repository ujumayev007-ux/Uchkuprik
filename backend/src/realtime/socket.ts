import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Services } from '../context.js';
import { authenticate, type AuthContext } from '../modules/auth/session.js';
import { branchRoom, tenantRoom, type EventBus } from './bus.js';

const REVALIDATE_MS = 60_000;

/** Order and kitchen events only reach staff who may see orders or the kitchen. */
const canSeeOrders = (auth: AuthContext) =>
  auth.permissions.has('orders.view') || auth.permissions.has('kitchen.access');

/**
 * Socket.io server bound to the API's HTTP server. Connections authenticate with the
 * same httpOnly session cookie as REST calls and join only their tenant and active
 * branch rooms, so events never cross tenant or branch boundaries.
 */
export function attachRealtime(
  httpServer: HttpServer,
  services: Services,
  bus: EventBus,
  appOrigin: string,
  allowSameHost = false,
) {
  const io = new Server(httpServer, {
    path: '/api/realtime',
    serveClient: false,
    cors: { origin: allowSameHost ? true : appOrigin, credentials: true },
    // Browsers send Origin on WebSocket upgrades; reject foreign pages outright.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const sameHost = allowSameHost && origin === `http://${req.headers.host}`;
      callback(null, !origin || origin === appOrigin || sameHost);
    },
    maxHttpBufferSize: 10_000,
  });

  io.use(async (socket, next) => {
    try {
      const result = await authenticate(
        services,
        socket.request.headers.cookie,
        { touch: false },
      );
      if (
        result.status !== 'ok' ||
        !result.auth.mfaVerified ||
        result.auth.tenantKind !== 'BUSINESS'
      )
        return next(new Error('UNAUTHENTICATED'));
      socket.data.auth = result.auth;
      socket.data.cookie = socket.request.headers.cookie;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const auth = socket.data.auth as AuthContext;
    void socket.join(tenantRoom(auth.tenantId));
    if (auth.activeBranchId && canSeeOrders(auth))
      void socket.join(branchRoom(auth.tenantId, auth.activeBranchId));
    socket.emit('ready', { branchId: auth.activeBranchId });
    // Revoked or expired sessions lose their live connection too.
    const timer = setInterval(async () => {
      const result = await authenticate(
        services,
        socket.data.cookie as string | undefined,
        { touch: false },
      ).catch(() => ({ status: 'invalid' as const }));
      if (result.status !== 'ok') socket.disconnect(true);
    }, REVALIDATE_MS);
    socket.on('disconnect', () => clearInterval(timer));
    // Clients never send business commands over the socket; REST stays the single write path.
    socket.onAny(() => undefined);
  });

  /**
   * SUPER_OWNER (or the Admin) changed settings: every open connection of the
   * restaurant is checked again. Connections that lost access to orders leave the
   * branch room, ended or blocked sessions are disconnected.
   */
  const recheck = async (tenantId: string) => {
    const sockets = await io.in(tenantRoom(tenantId)).fetchSockets();
    for (const socket of sockets) {
      const result = await authenticate(
        services,
        socket.data.cookie as string | undefined,
        { touch: false },
      ).catch(() => ({ status: 'invalid' as const }));
      if (result.status !== 'ok' || !result.auth.mfaVerified) {
        socket.disconnect(true);
        continue;
      }
      socket.data.auth = result.auth;
      const room = result.auth.activeBranchId
        ? branchRoom(tenantId, result.auth.activeBranchId)
        : null;
      if (!room) continue;
      if (canSeeOrders(result.auth)) socket.join(room);
      else socket.leave(room);
    }
  };

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'config.changed') void recheck(event.tenantId);
    if (
      event.type === 'menu.changed' ||
      event.type === 'inventory.changed' ||
      event.type === 'config.changed'
    )
      io.to(tenantRoom(event.tenantId)).emit(event.type, {});
    else if (
      event.type === 'order.table_needed' ||
      event.type === 'order.table_assigned'
    )
      io.to(branchRoom(event.tenantId, event.branchId)).emit(event.type, {
        orderId: event.orderId,
        number: event.number,
        byUserId: event.byUserId,
      });
    else
      io.to(branchRoom(event.tenantId, event.branchId)).emit(event.type, {
        orderId: event.orderId,
        ...(event.type === 'order.changed'
          ? { number: event.number, status: event.status }
          : event.type === 'order.updated'
            ? { number: event.number, version: event.version }
            : {}),
      });
  });

  return {
    io,
    close: async () => {
      unsubscribe();
      await io.close();
    },
  };
}
