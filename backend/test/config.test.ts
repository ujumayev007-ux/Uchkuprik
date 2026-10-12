import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://test:unit-test-value@localhost:5433/test',
  APP_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('environment validation', () => {
  it('accepts PostgreSQL settings and supplies bounded local defaults', () => {
    const config = parseConfig(env);
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe('127.0.0.1');
  });

  it('uses Render-provided host, port, and origin defaults', () => {
    const config = parseConfig({
      RENDER: 'true',
      RENDER_EXTERNAL_URL: 'https://uchkuprikfastfood.onrender.com',
      NODE_ENV: 'production',
      DATABASE_URL: `${env.DATABASE_URL}?sslmode=verify-full`,
      APP_SECRET_KEY: env.APP_SECRET_KEY,
      SERVE_FRONTEND: 'true',
    });
    expect(config.TRUST_PROXY).toBe(1);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.PORT).toBe(10000);
    expect(config.APP_ORIGIN).toBe('https://uchkuprikfastfood.onrender.com');
    expect(config.SERVE_FRONTEND).toBe(true);
  });

  it('preserves explicitly configured Render values', () => {
    const config = parseConfig({
      ...env,
      RENDER: 'true',
      RENDER_EXTERNAL_URL: 'https://ignored.onrender.com',
      APP_ORIGIN: 'https://restaurant.example',
      HOST: '127.0.0.1',
      PORT: '4100',
    });
    expect(config.APP_ORIGIN).toBe('https://restaurant.example');
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.PORT).toBe(4100);
  });

  it('does not waive database requirements on Render', () => {
    expect(() =>
      parseConfig({
        RENDER: 'true',
        RENDER_EXTERNAL_URL: 'https://test.onrender.com',
      }),
    ).toThrow('DATABASE_URL');
    expect(() => parseConfig({ ...env, SERVE_FRONTEND: 'yes' })).toThrow(
      'SERVE_FRONTEND',
    );
  });

  it('requires a strong APP_SECRET_KEY and trusts no proxy by default', () => {
    expect(parseConfig(env).TRUST_PROXY).toBe(0);
    for (const APP_SECRET_KEY of [
      undefined,
      'short',
      'REPLACE_WITH_RANDOM_SECRET_KEY',
      Buffer.alloc(16).toString('base64'),
    ])
      expect(() => parseConfig({ ...env, APP_SECRET_KEY })).toThrow(
        'APP_SECRET_KEY',
      );
  });

  it.each([
    { DATABASE_URL: undefined },
    { DATABASE_URL: 'https://localhost/database' },
    { DATABASE_URL: 'not-a-url' },
    {
      DATABASE_URL:
        'postgresql://test:REPLACE_WITH_RANDOM_PASSWORD@localhost/test',
    },
    { APP_ORIGIN: '*' },
    { APP_ORIGIN: 'http://localhost:5173/path' },
    { APP_ORIGIN: 'http://localhost:5173/' },
    { PORT: 'NaN' },
    { PORT: '0' },
    { PORT: '65536' },
  ])('rejects invalid settings without leaking values: %j', (overrides) => {
    expect(() => parseConfig({ ...env, ...overrides })).toThrow(
      'Invalid environment configuration:',
    );
  });

  it('does not echo credentials in a validation error', () => {
    try {
      parseConfig({
        ...env,
        DATABASE_URL: 'https://test:never-print-this@localhost/db',
      });
      expect.fail('Expected configuration validation to fail');
    } catch (error) {
      expect(String(error)).not.toContain('never-print-this');
      expect(String(error)).toContain('DATABASE_URL');
    }
  });

  it('requires HTTPS and verified PostgreSQL TLS in production', () => {
    expect(() => parseConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      'APP_ORIGIN, DATABASE_URL',
    );
    const config = parseConfig({
      ...env,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://restaurant.example',
      DATABASE_URL: `${env.DATABASE_URL}?sslmode=verify-full`,
    });
    expect(config.NODE_ENV).toBe('production');
  });
});
