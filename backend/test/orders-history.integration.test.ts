import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Order history for the cashier: GET /orders with a business-date range and a search.

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('order history filters', () => {
  it('filters by business date range and by number, name or phone', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Lagmon' },
    });
    const variant = await ctx.db.productVariant.create({
      data: { tenantId, productId: product.id, name: 'Standart', price: 30000 },
    });
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'owner').expect(200);
    const make = async (customerName: string, customerPhone: string) =>
      (
        await agent
          .post('/api/orders')
          .set('Origin', ORIGIN)
          .send({
            idempotencyKey: randomUUID(),
            type: 'TAKEAWAY',
            customerName,
            customerPhone,
            items: [{ variantId: variant.id, quantity: 1 }],
          })
          .expect(201)
      ).body as { id: string; number: number };
    const first = await make('Botir Aliyev', '+998901112233');
    const second = await make('Gulnora', '+998935551122');
    // Move the first order to an older business day.
    await ctx.db.order.update({
      where: { id: first.id },
      data: { businessDate: new Date('2026-01-05') },
    });
    const list = async (query: string) =>
      (
        (await agent.get(`/api/orders?scope=all&${query}`).expect(200)).body
          .orders as { id: string }[]
      ).map((order) => order.id);

    expect(await list('from=2026-01-01&to=2026-01-10')).toEqual([first.id]);
    const recent = await list('from=2026-02-01');
    expect(recent).toContain(second.id);
    expect(recent).not.toContain(first.id);
    expect(await list(`q=${second.number}`)).toContain(second.id);
    expect(await list('q=botir')).toEqual([first.id]);
    expect(await list('q=5551122')).toEqual([second.id]);
    // Without filters the list is unchanged.
    expect(await list('limit=200')).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    await agent.get('/api/orders?scope=all&from=2026-13-40').expect(400);
  });
});
