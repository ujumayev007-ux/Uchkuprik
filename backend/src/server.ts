import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import type { Services } from './context.js';
import { createPrisma } from './db.js';
import { createSecretBox } from './lib/crypto.js';
import { createEventBus } from './realtime/bus.js';
import { attachRealtime } from './realtime/socket.js';
import { enqueueKitchenTickets, startPrintWorker } from './printing/queue.js';
import { startBillingWorker } from './modules/billing/lifecycle.js';
import { startMaintenanceWorker } from './modules/assets/assets.routes.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const frontendDirectory = fileURLToPath(
    new URL('../../frontend/dist/', import.meta.url),
  );
  if (config.SERVE_FRONTEND && !existsSync(`${frontendDirectory}/index.html`)) {
    logger.fatal(
      'Frontend build is missing. Run npm run build before npm start.',
    );
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(config.DATABASE_URL);
  database.pool.on('error', () =>
    logger.error('Idle database connection failed'),
  );
  const prisma = createPrisma(config.DATABASE_URL);
  const events = createEventBus();
  const services = {
    db: prisma,
    secrets: createSecretBox(config.APP_SECRET_KEY),
    logger,
    secureCookies: config.NODE_ENV === 'production',
    events,
    limits: {
      credentialsPerMinute: config.CREDENTIAL_RATE_LIMIT,
      signupsPerHour: config.SIGNUP_RATE_LIMIT,
    },
  } as Services;
  services.afterOrderChange = (orderId) =>
    enqueueKitchenTickets(services, orderId);
  const stopPrinting = startPrintWorker(services);
  const stopBilling = startBillingWorker(services);
  const stopMaintenance = startMaintenanceWorker(services);
  let shuttingDown = false;
  const app = createApp({
    config,
    database,
    logger,
    services,
    isShuttingDown: () => shuttingDown,
    ...(config.SERVE_FRONTEND ? { frontendDirectory } : {}),
  });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });
  const realtime = attachRealtime(server, services, events, config.APP_ORIGIN);
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', () => {
    logger.fatal('API failed to listen');
    void database.close().finally(() => {
      process.exitCode = 1;
    });
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Graceful shutdown started');
    const deadline = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out');
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();
    void realtime.close();
    stopPrinting();
    stopBilling();
    stopMaintenance();
    server.close(() => {
      void Promise.all([database.close(), prisma.$disconnect()])
        .then(() => {
          clearTimeout(deadline);
          logger.info('Graceful shutdown completed');
        })
        .catch(() => {
          logger.error('Database shutdown failed');
          process.exitCode = 1;
        });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  // Configuration errors contain field names only. Never serialize raw driver errors.
  const message =
    error instanceof Error &&
    error.message.startsWith('Invalid environment configuration:')
      ? error.message
      : 'API startup failed';
  console.error(message);
  process.exitCode = 1;
});
