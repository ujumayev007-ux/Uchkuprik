import { Writable } from 'node:stream';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

function fixture(
  check = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  shuttingDown = false,
) {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const app = createApp({
    config: { APP_ORIGIN: 'http://localhost:5173' },
    database: { check },
    logger: pino(stream),
    isShuttingDown: () => shuttingDown,
  });
  return { app, check, logs };
}

describe('health API', () => {
  it('keeps liveness independent from database availability', async () => {
    const { app, check } = fixture(
      vi.fn().mockRejectedValue(new Error('database down')),
    );
    const response = await request(app).get('/api/health/live').expect(200);
    expect(response.body.status).toBe('ok');
    expect(check).not.toHaveBeenCalled();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('checks the database before reporting readiness', async () => {
    const { app, check } = fixture();
    const response = await request(app).get('/api/health/ready').expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      message: 'Tizim ulanishi tayyor.',
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it('returns 503 and never exposes raw database errors or request secrets', async () => {
    const secret = 'sensitive-test-value';
    const { app, logs } = fixture(
      vi
        .fn()
        .mockRejectedValue(
          new Error(`postgresql://admin:${secret}@internal-db`),
        ),
    );
    const response = await request(app)
      .get(`/api/health/ready?token=${secret}`)
      .set('Authorization', `Bearer ${secret}`)
      .expect(503);
    expect(response.body.status).toBe('unavailable');
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(logs.join('')).not.toContain(secret);
    expect(logs.join('')).not.toContain('internal-db');
  });

  it('rejects readiness during shutdown without acquiring another connection', async () => {
    const { app, check } = fixture(undefined, true);
    await request(app).get('/api/health/ready').expect(503);
    expect(check).not.toHaveBeenCalled();
  });

  it('allows only the configured browser origin', async () => {
    const { app } = fixture();
    const allowed = await request(app)
      .get('/api/health/live')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    const rejected = await request(app)
      .get('/api/health/live')
      .set('Origin', 'https://untrusted.example')
      .expect(403);
    expect(rejected.body.code).toBe('ORIGIN_FORBIDDEN');
  });

  it('returns an Uzbek 404 without reflecting untrusted content', async () => {
    const { app } = fixture();
    const response = await request(app)
      .get('/unknown?secret=sensitive')
      .expect(404);
    expect(response.body).toEqual({
      code: 'NOT_FOUND',
      message: 'So‘ralgan manzil topilmadi.',
    });
  });

  it('limits readiness traffic while preserving liveness probes', async () => {
    const { app, check } = fixture();
    for (let index = 0; index < 120; index += 1)
      await request(app).get('/api/health/ready').expect(200);
    const limited = await request(app).get('/api/health/ready').expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(check).toHaveBeenCalledTimes(120);
    await request(app).get('/api/health/live').expect(200);
  });
});
