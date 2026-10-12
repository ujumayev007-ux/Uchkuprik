import type { Logger } from 'pino';
import type { Db } from './db.js';
import type { SecretBox } from './lib/crypto.js';
import type { EventBus } from './realtime/bus.js';

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
  // Requests per minute. Defaults suit production; tests raise them.
  limits?: { credentialsPerMinute?: number; apiPerMinute?: number };
};
