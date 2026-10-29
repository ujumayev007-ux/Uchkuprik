import {
  notifyTelegramCustomer,
  startTelegramPolling,
} from './modules/telegram/bot.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import type { Services } from './context.js';
import { createPrisma } from './db.js';
import { createSecretBox } from './lib/crypto.js';
import { backupStore } from './lib/backup-store.js';
import { createEventBus } from './realtime/bus.js';
import { attachRealtime } from './realtime/socket.js';
import { enqueueKitchenTickets, startPrintWorker } from './printing/queue.js';
import { startScheduleWorker } from './modules/workflow/schedule.js';
import { autoPrintOrder } from './printing/auto.js';
import { startBillingWorker } from './modules/billing/lifecycle.js';
import { setEntitlementsOverride } from './modules/billing/entitlements.js';
import {
  licenseEntitlements,
  startLicenseSync,
} from './modules/license/license.js';
import { startMaintenanceWorker } from './modules/assets/assets.routes.js';
import { startNotificationWorker } from './modules/notifications/notify.js';
import { startWebhookWorker } from './modules/developer/webhooks.js';
import { createLogger } from './logger.js';
import { createControlRuntime } from './modules/control/runtime.js';
import { cloudViewProvider } from './modules/control/view.js';
import {
  exportPublicKey,
  publicKeyOf,
  readPem,
} from './modules/control/keys.js';

/** Same rule as the frontend build: the deployed commit, else the package version. */
function appVersion() {
  return (
    process.env.RENDER_GIT_COMMIT?.slice(0, 7) ||
    process.env.npm_package_version ||
    'dev'
  );
}

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
  // A non-UTF8 database silently rejects emoji and some Unicode text at write time.
  const encoding = await database.encoding().catch(() => null);
  if (encoding && encoding !== 'UTF8') {
    logger.fatal({ encoding }, 'Database must use UTF8 encoding');
    if (config.NODE_ENV === 'production') {
      await database.close();
      process.exitCode = 1;
      return;
    }
  }
  const prisma = createPrisma(config.DATABASE_URL);
  const events = createEventBus();
  const services = {
    db: prisma,
    secrets: createSecretBox(config.APP_SECRET_KEY),
    logger,
    secureCookies: config.NODE_ENV === 'production',
    events,
    selfHosted: config.SELF_HOSTED,
    hostRenameAgent: config.HOST_RENAME_AGENT,
    databaseUrl: config.DATABASE_URL,
    ...(config.INSTALL_ID ? { installId: config.INSTALL_ID } : {}),
    ...(config.INSTALLED_AT ? { installedAt: config.INSTALLED_AT } : {}),
    ...(config.LICENSE_STATUS_URL
      ? { licenseStatusUrl: config.LICENSE_STATUS_URL }
      : {}),
    control: (() => {
      const signingKeyPem = config.CONTROL_SIGNING_KEY
        ? readPem(config.CONTROL_SIGNING_KEY)
        : undefined;
      const trustedKeys = [
        ...(signingKeyPem ? [exportPublicKey(publicKeyOf(signingKeyPem))] : []),
        ...(config.CONTROL_PUBLIC_KEY?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) ?? []),
      ];
      return {
        plane: config.CONTROL_PLANE,
        ...(signingKeyPem ? { signingKeyPem } : {}),
        trustedKeys,
        ...(config.CONTROL_URL ? { url: config.CONTROL_URL } : {}),
        ...(config.CONTROL_RELOCATE_URL
          ? { relocateTo: config.CONTROL_RELOCATE_URL }
          : {}),
        ...(config.CONTROL_DEVICE_KEY
          ? { deviceKeyPem: readPem(config.CONTROL_DEVICE_KEY) }
          : {}),
      };
    })(),
    limits: {
      credentialsPerMinute: config.CREDENTIAL_RATE_LIMIT,
      signupsPerHour: config.SIGNUP_RATE_LIMIT,
    },
  } as Services;
  services.appVersion = appVersion();
  if (config.BACKUP_DIR)
    services.backups = backupStore({
      dir: config.BACKUP_DIR,
      dataDir: config.FASTFOOD_DATA_DIR ?? null,
      databaseUrl: config.DATABASE_URL,
      canSwap: config.RESTORE_SWAP,
    });
  // The launcher starts the server again (and swaps a prepared database in first).
  services.requestRestart = () => {
    logger.warn('Restarting for a database swap');
    setTimeout(() => process.exit(0), 1_500).unref();
  };
  // Control channel: installs report to the central server; the cloud edition reads
  // customer policies straight from its own tables.
  if (config.SELF_HOSTED && !config.CONTROL_PLANE) {
    services.controlRuntime = createControlRuntime(services);
    services.controlView = services.controlRuntime.view;
  } else
    services.controlView = cloudViewProvider(
      prisma,
      () => services.now?.() ?? new Date(),
    );
  const stopControl = services.controlRuntime
    ? services.controlRuntime.start()
    : () => undefined;
  services.afterOrderChange = async (orderId) => {
    await enqueueKitchenTickets(services, orderId);
    // Chop etish qoidalari bound to a printer (paid receipt, bill, delivery slip).
    await autoPrintOrder(services, orderId).catch(() =>
      logger.warn('Automatic receipt printing failed'),
    );
    await notifyTelegramCustomer(services, orderId).catch(() =>
      logger.warn('Telegram customer notice failed'),
    );
  };
  const stopPrinting = startPrintWorker(services);
  // Scheduled orders and banquets reach the kitchen on time.
  const stopSchedule = startScheduleWorker(services);
  const stopLicenseSync = config.SELF_HOSTED
    ? startLicenseSync(services)
    : () => undefined;
  if (config.SELF_HOSTED)
    setEntitlementsOverride(() => licenseEntitlements(services));
  const stopBilling = config.SELF_HOSTED
    ? () => undefined
    : startBillingWorker(services);
  const stopMaintenance = startMaintenanceWorker(services);
  const stopNotifications = startNotificationWorker(services);
  const stopWebhooks = startWebhookWorker(services);
  // Without a public HTTPS address (desktop) the bot is polled instead of webhooks.
  const stopTelegram = config.APP_ORIGIN.startsWith('https://')
    ? () => undefined
    : startTelegramPolling(services);
  let shuttingDown = false;
  const app = createApp({
    config,
    database,
    logger,
    services,
    isShuttingDown: () => shuttingDown,
    appVersion: appVersion(),
    ...(config.SERVE_FRONTEND ? { frontendDirectory } : {}),
  });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT }, 'API listening');
  });
  const realtime = attachRealtime(
    server,
    services,
    events,
    config.APP_ORIGIN,
    config.ALLOW_SAME_HOST_ORIGIN,
  );
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
    stopSchedule();
    stopBilling();
    stopMaintenance();
    stopNotifications();
    stopWebhooks();
    stopTelegram();
    stopLicenseSync();
    stopControl();
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
