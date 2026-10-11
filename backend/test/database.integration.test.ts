import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { createLogger } from '../src/logger.js';

// This suite deliberately fails when PostgreSQL is unavailable; no mock or skip fallback.
const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
afterAll(async () => database.close());

describe('real PostgreSQL connectivity', () => {
  it('executes a read-only query through a real connection', async () => {
    await expect(database.check()).resolves.toBeUndefined();
    const result = await database.pool.query<{ value: number }>(
      'SELECT 42::integer AS value',
    );
    expect(result.rows[0]?.value).toBe(42);
  });

  it('reports readiness through the HTTP API against PostgreSQL', async () => {
    const app = createApp({ config, database, logger: createLogger('silent') });
    const response = await request(app).get('/api/health/ready').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('returns unavailable when a real connection cannot be established', async () => {
    const unavailable = createDatabase(
      'postgresql://invalid@127.0.0.1:1/unavailable',
    );
    try {
      const app = createApp({
        config,
        database: unavailable,
        logger: createLogger('silent'),
      });
      const response = await request(app).get('/api/health/ready').expect(503);
      expect(response.body.status).toBe('unavailable');
    } finally {
      await unavailable.close();
    }
  });
});
