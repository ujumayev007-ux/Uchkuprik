import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const env = {
  APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://test:unit-test-value@localhost:5433/test',
};

describe('environment validation', () => {
  it('accepts PostgreSQL settings and supplies bounded local defaults', () => {
    const config = parseConfig(env);
    expect(config.PORT).toBe(4000);
    expect(config.HOST).toBe('127.0.0.1');
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
