import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('fiscal settings and reconciliation (no provider connected)', () => {
  it('stores details, never returns the secret and reports unregistered receipts honestly', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await owner
      .put('/api/settings/fiscal')
      .set('Origin', ORIGIN)
      .send({ enabled: true, provider: 'OFD', tin: '12345', terminalId: 'T1' })
      .expect(400); // TIN must be 9 or 14 digits
    await owner
      .put('/api/settings/fiscal')
      .set('Origin', ORIGIN)
      .send({
        enabled: true,
        provider: 'OFD',
        tin: '123456789',
        terminalId: 'T1',
        credentials: 'super-secret-provider-key',
      })
      .expect(200);
    const settings = await owner.get('/api/settings/fiscal').expect(200);
    expect(settings.body).toMatchObject({
      enabled: true,
      tin: '123456789',
      hasCredentials: true,
      connected: false,
    });
    expect(JSON.stringify(settings.body)).not.toContain('super-secret');
    const profile = await ctx.db.tenantProfile.findUniqueOrThrow({
      where: { tenantId: tenant.tenant.id },
    });
    expect(profile.fiscalCredentialsEnc).not.toContain('super-secret');

    const today = new Date(Date.now() + 5 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    const order = await ctx.db.order.create({
      data: {
        tenantId: tenant.tenant.id,
        branchId: tenant.branch.id,
        number: 77,
        businessDate: new Date(today),
        type: 'TAKEAWAY',
        status: 'COMPLETED',
        subtotal: 25000,
        total: 25000,
        completedAt: new Date(),
        idempotencyKey: randomUUID(),
      },
    });
    await ctx.db.fiscalReceipt.create({
      data: {
        tenantId: tenant.tenant.id,
        orderId: order.id,
        status: 'NOT_CONFIGURED',
      },
    });
    const report = await owner
      .get(`/api/reports/fiscal?from=${today}&to=${today}`)
      .expect(200);
    expect(report.body.summary.NOT_CONFIGURED).toEqual({
      count: 1,
      total: 25000,
    });
    expect(report.body.summary.REGISTERED).toBeUndefined();
    expect(report.body.unregistered[0]).toMatchObject({ number: 77 });
  });
});
