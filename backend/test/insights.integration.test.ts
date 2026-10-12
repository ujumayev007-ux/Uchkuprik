import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
const METRICS_TOKEN = 'metrics-token-for-tests-0123456789abcdef';
const probe = createDatabase(loadConfig().DATABASE_URL);
const app = createApp({
  config: { APP_ORIGIN: ORIGIN, METRICS_TOKEN },
  database: probe,
  logger: ctx.services.logger,
  services: ctx.services,
});
afterAll(async () => {
  await probe.close();
  await ctx.close();
});
const DAY = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe('metrics endpoint', () => {
  it('is hidden without the token and exposes low-cardinality metrics with it', async () => {
    await request(app).get('/api/health/live').expect(200);
    await request(app).get('/api/metrics').expect(404);
    await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer wrong-token')
      .expect(404);
    const metrics = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
    expect(metrics.text).toContain(
      'ff_http_requests_total{method="GET",status="2xx"}',
    );
    expect(metrics.text).toContain('ff_notification_jobs_pending');
    // No paths, tenants or users in labels.
    expect(metrics.text).not.toContain('/api/');
  });
});

describe('forecast and risk signals', () => {
  it('forecasts by weekday average and flags unusual employee behaviour', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const branchId = tenant.branch.id;
    const owner = request.agent(app);
    await login(owner, tenant.slug, 'owner').expect(200);
    const today = new Date(`${iso(new Date())}T00:00:00.000Z`);
    const cashier = await addUser(ctx, tenantId, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const honest = await addUser(ctx, tenantId, {
      username: 'kassir2',
      roleIds: [tenant.roleId('cashier')],
    });

    // Same weekday one and two weeks ago: 100 000 and 200 000 so‘m.
    let number = 1;
    for (const [weeks, total] of [
      [1, 100_000],
      [2, 200_000],
    ] as const)
      await ctx.db.order.create({
        data: {
          tenantId,
          branchId,
          number: number++,
          businessDate: new Date(today.getTime() - weeks * 7 * DAY),
          type: 'TAKEAWAY',
          idempotencyKey: randomUUID(),
          status: 'COMPLETED',
          total,
          createdById: honest.id,
          completedAt: new Date(),
        },
      });
    const forecast = await owner
      .get(`/api/reports/forecast?branchId=${branchId}&days=7`)
      .expect(200);
    expect(forecast.body.forecast[0]).toMatchObject({
      date: iso(today),
      revenue: 37_500,
      orders: 0,
    });
    // 300 000 over 8 sampled weeks; next weekday without history is 0.
    expect(forecast.body.forecast[1].revenue).toBe(0);

    // One cashier cancels many placed orders; another sells normally.
    for (let i = 0; i < 6; i++) {
      const order = await ctx.db.order.create({
        data: {
          tenantId,
          branchId,
          number: number++,
          businessDate: today,
          type: 'TAKEAWAY',
          idempotencyKey: randomUUID(),
          status: 'CANCELLED',
          total: 50_000,
          createdById: cashier.id,
        },
      });
      await ctx.db.orderEvent.create({
        data: {
          tenantId,
          orderId: order.id,
          type: 'status',
          actorId: cashier.id,
          data: { from: 'PLACED', to: 'CANCELLED' },
        },
      });
    }
    await ctx.db.order.create({
      data: {
        tenantId,
        branchId,
        number: number++,
        businessDate: today,
        type: 'TAKEAWAY',
        idempotencyKey: randomUUID(),
        status: 'COMPLETED',
        subtotal: 100_000,
        discountTotal: 30_000,
        total: 70_000,
        createdById: cashier.id,
        completedAt: new Date(),
      },
    });
    const risk = await owner
      .get(`/api/reports/risk?from=${iso(today)}&to=${iso(today)}`)
      .expect(200);
    const flagged = risk.body.employees.find(
      (row: { userId: string }) => row.userId === cashier.id,
    );
    expect(flagged.flags).toEqual(
      expect.arrayContaining(['CANCELLATIONS', 'DISCOUNTS']),
    );
    expect(flagged.cancellations).toBe(6);

    // Cashiers cannot see risk signals.
    const staff = request.agent(app);
    await login(staff, tenant.slug, 'kassir').expect(200);
    await staff
      .get(`/api/reports/risk?from=${iso(today)}&to=${iso(today)}`)
      .expect(403);
  });
});
