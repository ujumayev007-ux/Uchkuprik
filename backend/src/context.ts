import type { Logger } from 'pino';
import type { Db } from './db.js';
import type { SecretBox } from './lib/crypto.js';
import type { EventBus } from './realtime/bus.js';
import type { TelegramTransport } from './modules/notifications/notify.js';
import type { WebhookSender } from './modules/developer/webhooks.js';

export type Services = {
  db: Db;
  secrets: SecretBox;
  logger: Logger;
  // Secure cookies with the __Host- prefix require HTTPS (production).
  secureCookies: boolean;
  now?: () => Date;
  // Real-time notifications; optional so tests and tools can run without sockets.
  events?: EventBus;
  // Post-commit hook for order changes (kitchen ticket printing).
  afterOrderChange?: (orderId: string) => Promise<void>;
  // Telegram Bot API client; tests inject a fake, production uses the real API.
  telegram?: TelegramTransport;
  // Outgoing webhook HTTP client; tests inject a recorder.
  webhookSender?: WebhookSender;
  // Desktop/self-hosted install: no SaaS subscriptions or billing.
  selfHosted?: boolean;
  // Identity of this desktop install (licences are bound to it) and first install time.
  installId?: string;
  installedAt?: Date;
  // Vendor status document for remote licence renewals and blocking.
  licenseStatusUrl?: string;
  // Requests per minute. Defaults suit production; tests raise them.
  limits?: {
    credentialsPerMinute?: number;
    apiPerMinute?: number;
    // Per hour; 0 disables self-service registration.
    signupsPerHour?: number;
  };
};
