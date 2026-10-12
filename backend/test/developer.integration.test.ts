import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Services } from '../src/context.js';
import { createDatabase } from '../src/database.js';
import {
  assertPublicUrl,
  emitWebhook,
  processWebhookDeliveries,
  type WebhookSender,
} from '../src/modules/developer/webhooks.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
const received: {
  url: string;
  headers: Record<string, string>;
  body: string;
}[] = [];
let responseStatus = 200;
const sender: WebhookSender = async (url, headers, body) => {
  received.push({ url, headers, body });
  return responseStatus;
};
const services: Services = { ...ctx.services, webhookSender: sender };
const probe = createDatabase(loadConfig().DATABASE_URL);
const app = createApp({
  config: { APP_ORIGIN: ORIGIN },
  database: probe,
  logger: services.logger,
  services,
});
afterAll(async () => {
  await probe.close();
  await ctx.close();
});
const agent = () => request.agent(app);
type Agent = ReturnType<typeof agent>;
const post = (a: Agent, path: string, body: object = {}) =>
  a.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const today = new Date().toISOString().slice(0, 10);

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const category = await ctx.db.menuCategory.create({
    data: { tenantId: tenant.tenant.id, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: {
      tenantId: tenant.tenant.id,
      categoryId: category.id,
      name: 'Lavash',
    },
  });
  await ctx.db.productVariant.create({
    data: {
      tenantId: tenant.tenant.id,
      productId: product.id,
      name: 'Standart',
      price: 32000,
      cost: 15000,
    },
  });
  return { tenant, tenantId: tenant.tenant.id, owner };
}

describe('public API keys', () => {
  it('issues a key once, enforces scopes, isolates tenants and honours revocation', async () => {
    const s = await setup();
    const created = await post(s.owner, '/developer/api-keys', {
      name: 'Buxgalteriya integratsiyasi',
      scopes: ['menu.read', 'reports.read'],
    }).expect(201);
    const key: string = created.body.key;
    expect(key).toMatch(/^ffk_/);
    const listed = await s.owner.get('/api/developer/api-keys').expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(key);
    const stored = await ctx.db.apiKey.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.keyHash).not.toContain(key.slice(4));

    const api = (path: string, token = key) =>
      request(app).get(`/api${path}`).set('Authorization', `Bearer ${token}`);
    await request(app).get('/api/v1/menu').expect(401);
    expect((await api('/v1/menu', 'ffk_' + 'x'.repeat(40))).body.code).toBe(
      'API_KEY_INVALID',
    );
    const menu = await api('/v1/menu').expect(200);
    expect(menu.body.products[0].name).toBe('Lavash');
    // Costs are never part of the public API.
    expect(JSON.stringify(menu.body)).not.toContain('15000');
    expect((await api(`/v1/orders?from=${today}&to=${today}`)).body.code).toBe(
      'API_SCOPE_MISSING',
    );
    await api(`/v1/reports/sales?from=${today}&to=${today}`).expect(200);

    // Another tenant's key only sees its own data.
    const other = await setup();
    const otherKey = await post(other.owner, '/developer/api-keys', {
      name: 'Boshqa',
      scopes: ['orders.read'],
    }).expect(201);
    const order = await ctx.db.order.create({
      data: {
        tenantId: s.tenantId,
        branchId: s.tenant.branch.id,
        number: 1,
        businessDate: new Date(`${today}T00:00:00.000Z`),
        type: 'TAKEAWAY',
        idempotencyKey: crypto.randomUUID(),
        status: 'COMPLETED',
        total: 32000,
      },
    });
    const foreign = await api(
      `/v1/orders?from=${today}&to=${today}`,
      otherKey.body.key,
    ).expect(200);
    expect(
      foreign.body.data.map((row: { id: string }) => row.id),
    ).not.toContain(order.id);

    await post(s.owner, `/developer/api-keys/${created.body.id}/revoke`).expect(
      200,
    );
    expect((await api('/v1/menu')).body.code).toBe('API_KEY_INVALID');

    // Plans without the developer API feature reject keys.
    const basic = await ctx.db.plan.findUniqueOrThrow({
      where: { code: 'BASIC' },
    });
    await ctx.db.subscription.create({
      data: {
        tenantId: other.tenantId,
        planId: basic.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    expect(
      (await api(`/v1/orders?from=${today}&to=${today}`, otherKey.body.key))
        .body.code,
    ).toBe('FEATURE_NOT_IN_PLAN');
  });
});

describe('signed webhooks', () => {
  it('signs deliveries with HMAC, retries failures and records the log', async () => {
    const s = await setup();
    const endpoint = await post(s.owner, '/developer/webhooks', {
      url: 'https://hooks.example.com/fastfood',
      events: ['order.completed'],
    }).expect(201);
    const secret: string = endpoint.body.secret;
    expect(secret).toMatch(/^whsec_/);
    const listed = await s.owner.get('/api/developer/webhooks').expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);

    expect(
      await emitWebhook(ctx.db, s.tenantId, 'order.cancelled', { id: 'x' }),
    ).toBe(0);
    expect(
      await emitWebhook(ctx.db, s.tenantId, 'order.completed', {
        id: 'order-1',
        total: 32000,
      }),
    ).toBe(1);

    responseStatus = 500;
    await processWebhookDeliveries(services);
    let log = await s.owner
      .get(`/api/developer/webhooks/${endpoint.body.id}/deliveries`)
      .expect(200);
    expect(log.body.deliveries[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      responseStatus: 500,
      lastError: 'HTTP 500',
    });

    responseStatus = 204;
    await ctx.db.webhookDelivery.updateMany({
      where: { tenantId: s.tenantId },
      data: { nextTryAt: new Date(0) },
    });
    await processWebhookDeliveries(services);
    log = await s.owner
      .get(`/api/developer/webhooks/${endpoint.body.id}/deliveries`)
      .expect(200);
    expect(log.body.deliveries[0].status).toBe('SENT');

    const delivered = received
      .filter((call) => call.body.includes('order-1'))
      .at(-1)!;
    const header = delivered.headers['X-Fastfood-Signature']!;
    const [, t, v1] = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    const expected = createHmac('sha256', secret)
      .update(`${t}.${delivered.body}`)
      .digest('hex');
    expect(v1).toBe(expected);
    expect(JSON.parse(delivered.body)).toMatchObject({
      event: 'order.completed',
      data: { id: 'order-1', total: 32000 },
    });
  });

  it('refuses webhook URLs that point to private networks', async () => {
    for (const url of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://user:pass@example.com/hook',
    ])
      await expect(assertPublicUrl(url)).rejects.toThrow();
    await expect(
      assertPublicUrl('https://93.184.216.34/hook'),
    ).resolves.toBeUndefined();
  });
});
