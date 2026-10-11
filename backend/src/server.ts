import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const database = createDatabase(config.DATABASE_URL);
  database.pool.on('error', () =>
    logger.error('Idle database connection failed'),
  );
  let shuttingDown = false;
  const app = createApp({
    config,
    database,
    logger,
    isShuttingDown: () => shuttingDown,
  });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });
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
    server.close(() => {
      void database
        .close()
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
