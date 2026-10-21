import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import { createPrisma } from '../src/db.js';
import { createSecretBox } from '../src/lib/crypto.js';
import { createLogger } from '../src/logger.js';

// A restaurant server is opened by address on its own network (http://192.168.1.8:8787).
// "Upgrade every request to https" would make the browser fetch the page's own files
// over https from a server that only speaks http, and the page would never start.
const config = loadConfig();
const db = createPrisma(config.DATABASE_URL);
const probe = createDatabase(config.DATABASE_URL);
const services: Services = {
  db,
  secrets: createSecretBox(config.APP_SECRET_KEY),
  logger: createLogger('silent'),
  secureCookies: false,
};
afterAll(async () => {
  await Promise.all([db.$disconnect(), probe.close()]);
});

const headersOf = async (origin: string) => {
  const app = createApp({
    config: { APP_ORIGIN: origin },
    database: probe,
    logger: services.logger,
    services,
  });
  return (await request(app).get('/api/health/live')).headers;
};

describe('security headers follow how the server is reached', () => {
  it('plain-http restaurant servers do not force https upgrades or HSTS', async () => {
    const headers = await headersOf('http://192.168.1.8:8787');
    const csp = String(headers['content-security-policy']);
    expect(csp).not.toContain('upgrade-insecure-requests');
    // The rest of the policy stays strict.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('hosted https servers keep both', async () => {
    const headers = await headersOf('https://restoran.example');
    expect(String(headers['content-security-policy'])).toContain(
      'upgrade-insecure-requests',
    );
    expect(headers['strict-transport-security']).toContain('max-age');
  });
});
