import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { onOrderCompleted } from '../src/modules/crm/loyalty.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('loyalty rules', () => {
  it('rewards every N-th order and the birthday once, and shows the level', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await owner
      .put('/api/settings/loyalty-rules')
      .set('Origin', ORIGIN)
      .send({
        tiers: [
          { name: 'Bronze', minSpent: 0, bonusBp: 0 },
          { name: 'Gold', minSpent: 50000, bonusBp: 200 },
        ],
        everyNth: { n: 3, points: 5000 },
        birthdayPoints: 7000,
      })
      .expect(200);
    const now = new Date(Date.now() + 5 * 3_600_000);
    const customer = await ctx.db.customer.create({
      data: {
        tenantId,
        phone: '+998905550000',
        birthday: new Date(Date.UTC(1995, now.getUTCMonth(), now.getUTCDate())),
      },
    });
    for (let i = 0; i < 3; i++) {
      const order = await ctx.db.order.create({
        data: {
          tenantId,
          branchId: tenant.branch.id,
          number: 900 + i,
          businessDate: new Date(),
          type: 'TAKEAWAY',
          total: 20000,
          subtotal: 20000,
          customerId: customer.id,
          idempotencyKey: randomUUID(),
        },
      });
      await ctx.db.$transaction((tx) => onOrderCompleted(tx, order.id, null));
    }
    const entries = await ctx.db.loyaltyEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(entries.map((entry) => [entry.reason, entry.points])).toEqual(
      expect.arrayContaining([
        ['3-xarid sovg‘asi', 5000],
        [`Tug‘ilgan kun ${now.getUTCFullYear()}`, 7000],
      ]),
    );
    // Birthday gift only once per year.
    expect(
      entries.filter((entry) => entry.reason?.startsWith('Tug‘ilgan')),
    ).toHaveLength(1);
    const list = await owner.get('/api/customers').expect(200);
    expect(
      list.body.customers.find((c: { id: string }) => c.id === customer.id)
        .level,
    ).toBe('Gold');
  });
});
