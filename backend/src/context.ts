import type { Logger } from 'pino';
import type { Db } from './db.js';
import type { SecretBox } from './lib/crypto.js';

export type Services = {
  db: Db;
  secrets: SecretBox;
  logger: Logger;
  // Secure cookies with the __Host- prefix require HTTPS (production).
  secureCookies: boolean;
  now?: () => Date;
  // Requests per minute. Defaults suit production; tests raise them.
  limits?: { credentialsPerMinute?: number; apiPerMinute?: number };
};
