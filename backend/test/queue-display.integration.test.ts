import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(async () => {
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('customer queue display account', () => {
  it('a display user sees queue numbers only and can do nothing else', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const category = await post(owner, '/menu/categories', {
      name: 'Taom',
    }).expect(201);
    const product = await post(owner, '/menu/products', {
      categoryId: category.body.id,
      name: 'Osh',
      variants: [{ name: 'Standart', price: 30_000, cost: 10_000 }],
    }).expect(201);
    const variant = await ctx.db.productVariant.findFirstOrThrow({
      where: { tenantId, productId: product.body.id },
    });
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      customerName: 'Maxfiy Mijoz',
      customerPhone: '+998901112233',
      items: [{ variantId: variant.id, quantity: 2 }],
    }).expect(201);

    await addUser(ctx, tenantId, {
      username: 'ekran',
      roleIds: [tenant.roleId('display')],
    });
    const tv = ctx.agent();
    await login(tv, tenant.slug, 'ekran').expect(200);

    const queue = await tv.get('/api/queue').expect(200);
    expect(queue.body.preparing).toContain(order.body.number);
    // Numbers only: no names, phones, prices or order ids of unfinished orders.
    const text = JSON.stringify(queue.body);
    expect(text).not.toMatch(
      /Maxfiy|998901112233|30000|60000|total|price|cost/i,
    );

    for (const path of [
      '/orders',
      '/kitchen/tickets',
      '/reports/sales',
      '/inventory/items',
      '/users',
      '/customers',
    ])
      await tv.get(`/api${path}`).expect(403);
    await post(tv, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [],
    }).expect(403);
    await post(tv, `/kitchen/orders/${order.body.id}/accept`).expect(403);
    await post(tv, `/orders/${order.body.id}/serve`).expect(403);

    // Ready: the display shows it as ready without being able to change anything.
    await post(owner, `/kitchen/orders/${order.body.id}/accept`).expect(200);
    await post(owner, `/kitchen/orders/${order.body.id}/bump`, {
      status: 'READY',
    }).expect(200);
    const ready = await tv.get('/api/queue').expect(200);
    expect(ready.body.ready.map((r: { number: number }) => r.number)).toContain(
      order.body.number,
    );
  });
});
