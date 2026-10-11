import { pino } from 'pino';
import type { AppConfig } from './config.js';

export function createLogger(level: AppConfig['LOG_LEVEL']) {
  return pino({
    level,
    base: { service: 'fastfood-api' },
    redact: {
      paths: [
        'password',
        'pin',
        'token',
        'secret',
        'DATABASE_URL',
        'authorization',
        'cookie',
      ],
      censor: '[REDACTED]',
    },
  });
}
