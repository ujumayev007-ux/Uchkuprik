import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Queue TV application: a registered DISPLAY device reads the queue without a staff
// sign-in; any other device, a revoked one or no device gets nothing.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('Queue TV display (no sign-in)', () => {
  it('shows numbers and statuses only to a registered display device', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const category = await post(owner, '/menu/categories', {
      name: 'Fast Food',
    }).expect(201);
    const product = await post(owner, '/menu/products', {
      categoryId: category.body.id,
      name: 'Lavash',
      variants: [{ name: 'Standart', price: 28000 }],
    }).expect(201);
    const variant = await ctx.db.productVariant.findFirstOrThrow({
      where: { productId: product.body.id },
    });
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);

    const register = async (panel: string) => {
      const agent = ctx.agent();
      await login(agent, tenant.slug, 'owner').expect(200);
      const created = await post(agent, '/devices/register', {
        branchId: tenant.branch.id,
        name: `${panel} 1`,
        panel,
      }).expect(201);
      await post(agent, '/auth/logout').expect(204);
      return { agent, id: created.body.id as string };
    };
    const tv = await register('DISPLAY');
    const shown = await tv.agent.get('/api/queue/display').expect(200);
    expect(shown.body.preparing).toContain(order.body.number);
    expect(JSON.stringify(shown.body)).not.toMatch(/Lavash|28000|total/);
    // Still no staff session on that device.
    expect((await tv.agent.get('/api/auth/me')).body?.user ?? null).toBeNull();

    const kassa = await register('CASHIER');
    expect(
      (await kassa.agent.get('/api/queue/display').expect(403)).body.code,
    ).toBe('DEVICE_REQUIRED');
    expect(
      (await ctx.agent().get('/api/queue/display').expect(403)).body.code,
    ).toBe('DEVICE_REQUIRED');
    await post(owner, `/devices/${tv.id}/revoke`).expect(200);
    await tv.agent.get('/api/queue/display').expect(403);
  });
});
