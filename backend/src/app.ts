import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { DatabaseProbe } from './database.js';
import { messages } from './messages.js';

type Dependencies = {
  config: Pick<AppConfig, 'APP_ORIGIN'>;
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
}: Dependencies) {
  const app = express();
  app.disable('x-powered-by');
  // Proxy trust stays off until a deployment-specific trusted proxy range is defined.
  app.use(helmet());
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
      limit: 120,
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
    _error: unknown,
    _req,
    res,
    _next,
  ) => {
    logger.error(
      { requestId: res.locals.requestId },
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
