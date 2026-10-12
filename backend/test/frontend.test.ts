import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fastfood-frontend-test-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><html lang="uz"><title>Tizim holati</title></html>',
  );
  await writeFile(
    join(directory, 'assets', 'app.js'),
    'window.appLoaded = true;',
  );
  await writeFile(
    join(directory, '.env'),
    'SECRET=never-expose-this-test-value',
  );
});
afterAll(async () => {
  if (
    directory &&
    resolve(directory).startsWith(
      join(resolve(tmpdir()), 'fastfood-frontend-test-'),
    )
  ) {
    await rm(directory, { recursive: true });
  }
});

function app() {
  return createApp({
    config: { APP_ORIGIN: 'https://uchkuprikfastfood.onrender.com' },
    database: { check: async () => {} },
    logger: createLogger('silent'),
    frontendDirectory: directory,
  });
}

describe('single-service frontend hosting', () => {
  it('serves the Uzbek frontend and compiled assets with security headers', async () => {
    const response = await request(app())
      .get('/')
      .expect(200)
      .expect('Content-Type', /html/);
    expect(response.text).toContain('lang="uz"');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    const script = await request(app()).get('/assets/app.js').expect(200);
    expect(script.text).toContain('appLoaded');
  });

  it('supports frontend routes without swallowing API errors', async () => {
    await request(app())
      .get('/future-route')
      .set('Accept', 'text/html')
      .expect(200)
      .expect('Content-Type', /html/);
    await request(app())
      .get('/api/health/live')
      .expect(200)
      .expect('Content-Type', /json/);
    const unknown = await request(app())
      .get('/api/missing')
      .set('Accept', 'text/html')
      .expect(404);
    expect(unknown.body.code).toBe('NOT_FOUND');
  });

  it.each([
    '/.env',
    '/.git/config',
    '/backend/src/server.ts',
    '/assets/missing.js',
  ])(
    'does not expose server files or replace missing assets with HTML: %s',
    async (path) => {
      const response = await request(app()).get(path).expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.text).not.toContain('never-expose-this-test-value');
    },
  );
});
