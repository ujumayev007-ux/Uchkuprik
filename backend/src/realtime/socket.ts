import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { Services } from '../context.js';
import { authenticate, type AuthContext } from '../modules/auth/session.js';
import { branchRoom, tenantRoom, type EventBus } from './bus.js';

const REVALIDATE_MS = 60_000;

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
    if (auth.activeBranchId)
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

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'menu.changed')
      io.to(tenantRoom(event.tenantId)).emit(event.type, {});
    else
      io.to(branchRoom(event.tenantId, event.branchId)).emit(event.type, {
        orderId: event.orderId,
        ...(event.type === 'order.changed'
          ? { number: event.number, status: event.status }
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
