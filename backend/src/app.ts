import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sha256 } from './lib/crypto.js';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Services } from './context.js';
import type { DatabaseProbe } from './database.js';
import { AppError, sendError } from './http/errors.js';
import { messages } from './messages.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { loadSession } from './modules/auth/session.js';
import { branchesRouter } from './modules/branches/branches.routes.js';
import { devicesRouter } from './modules/devices/devices.routes.js';
import { floorRouter } from './modules/floor/floor.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { kitchenRouter } from './modules/kitchen/kitchen.routes.js';
import { printersRouter } from './modules/printing/printers.routes.js';
import { menuRouter } from './modules/menu/menu.routes.js';
import { onlineRouter } from './modules/online/online.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { shiftsRouter } from './modules/shifts/shifts.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { platformRouter } from './modules/tenants/platform.routes.js';
import { rolesRouter } from './modules/users/roles.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

type Dependencies = {
  config: Pick<AppConfig, 'APP_ORIGIN'> &
    Partial<Pick<AppConfig, 'TRUST_PROXY'>>;
  // Business APIs are mounted only when persistence services are provided.
  services?: Services;
  database: DatabaseProbe;
  logger: Logger;
  isShuttingDown?: () => boolean;
  frontendDirectory?: string;
};

export function createApp({
  config,
  database,
  logger,
  isShuttingDown = () => false,
  frontendDirectory,
  services,
}: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  // Trust only the configured number of proxy hops so req.ip cannot be spoofed.
  app.set('trust proxy', config.TRUST_PROXY ?? 0);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Menu images may be hosted on HTTPS object storage/CDNs; scripts stay same-origin.
          'img-src': ["'self'", 'data:', 'https:'],
        },
      },
    }),
  );
  app.use((_req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => {
      // Do not record URLs, headers, bodies or raw errors: they can contain secrets.
      logger.info(
        {
          requestId,
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        'Request completed',
      );
    });
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== config.APP_ORIGIN) {
      res
        .status(403)
        .json({ code: 'ORIGIN_FORBIDDEN', message: messages.forbiddenOrigin });
      return;
    }
    next();
  });
  app.use(
    cors({ origin: config.APP_ORIGIN, methods: ['GET'], credentials: false }),
  );
  app.get('/api/health/live', (_req, res) => {
    res.json({ status: 'ok', message: messages.live });
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: services?.limits?.apiPerMinute ?? 600,
      // Terminals of one restaurant often share a NAT address, so authenticated
      // traffic is limited per session and anonymous traffic per IP.
      keyGenerator: (req) => {
        const cookie = req.headers.cookie?.match(
          /ff_session=([A-Za-z0-9_-]+)/,
        )?.[1];
        return cookie
          ? `s:${sha256(cookie)}`
          : `ip:${ipKeyGenerator(req.ip ?? '')}`;
      },
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { code: 'RATE_LIMITED', message: messages.rateLimited },
    }),
  );
  app.get('/api/health/ready', async (_req, res) => {
    if (isShuttingDown()) {
      res
        .status(503)
        .json({ status: 'unavailable', message: messages.unavailable });
      return;
    }
    try {
      await database.check();
      res.json({ status: 'ok', message: messages.ready });
    } catch {
      logger.warn(
        { requestId: res.locals.requestId },
        'Database readiness check failed',
      );
      res
        .status(503)
        .json({ status: 'unavailable', message: messages.unavailable });
    }
  });
  if (services) {
    app.use('/api', express.json({ limit: '100kb' }));
    app.use('/api', loadSession(services));
    for (const router of [
      authRouter,
      usersRouter,
      rolesRouter,
      branchesRouter,
      devicesRouter,
      platformRouter,
      auditRouter,
      settingsRouter,
      floorRouter,
      menuRouter,
      shiftsRouter,
      ordersRouter,
      reportsRouter,
      kitchenRouter,
      printersRouter,
      inventoryRouter,
      onlineRouter,
    ])
      app.use('/api', router(services));
  }
  // Never return the SPA document for an unknown API endpoint.
  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: messages.notFound });
  });
  if (frontendDirectory) {
    // Serve the frontend build only, never the repository or server files.
    app.use(
      express.static(frontendDirectory, {
        index: false,
        dotfiles: 'ignore',
        redirect: false,
      }),
    );
    app.get('/{*path}', (req, res, next) => {
      const hiddenPath = req.path
        .split('/')
        .some((part) => part.startsWith('.'));
      if (hiddenPath || extname(req.path) || !req.accepts('html')) {
        next();
        return;
      }
      res.sendFile(join(frontendDirectory, 'index.html'));
    });
  }
  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', message: messages.notFound });
  });
  const handleError: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof AppError) {
      if (!res.headersSent) sendError(res, error);
      return;
    }
    // Malformed JSON bodies from express.json().
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      (error.type === 'entity.parse.failed' ||
        error.type === 'entity.too.large')
    ) {
      res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', message: messages.validation });
      return;
    }
    // Log only the error class and driver code; messages may contain data.
    logger.error(
      {
        requestId: res.locals.requestId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined,
      },
      'Unhandled request error',
    );
    if (!res.headersSent)
      res
        .status(500)
        .json({ code: 'INTERNAL_ERROR', message: messages.internal });
  };
  app.use(handleError);
  return app;
}
