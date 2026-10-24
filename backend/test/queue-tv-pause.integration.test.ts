import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Kassa «TV ekrani»: the cashier pauses and resumes the branch's queue TVs. A paused TV
// keeps answering (pause screen) and comes back by itself; a kitchen user can not switch.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('Kassa TV switch', () => {
  it('pauses and resumes the queue TVs of the branch', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
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

    const tv = ctx.agent();
    await login(tv, tenant.slug, 'owner').expect(200);
    await post(tv, '/devices/register', {
      branchId: tenant.branch.id,
      name: 'TV 1',
      panel: 'DISPLAY',
    }).expect(201);
    await post(tv, '/auth/logout').expect(204);

    await addUser(ctx, tenantId, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    await addUser(ctx, tenantId, {
      username: 'oshpaz',
      roleIds: [tenant.roleId('kitchen')],
    });
    const cashier = ctx.agent();
    const cook = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    await login(cook, tenant.slug, 'oshpaz').expect(200);

    const state = await cashier.get('/api/queue/tv').expect(200);
    expect(state.body).toMatchObject({ enabled: true, paused: false });
    expect(
      (await tv.get('/api/queue/display').expect(200)).body,
    ).toMatchObject({ paused: false });

    await put(cook, '/queue/tv', { paused: true }).expect(403);
    await put(cashier, '/queue/tv', { paused: true }).expect(200);
    expect((await cashier.get('/api/queue/tv').expect(200)).body.paused).toBe(
      true,
    );
    const paused = await tv.get('/api/queue/display').expect(200);
    expect(paused.body.paused).toBe(true);
    // The orders are still counted, only the screen is paused.
    expect(paused.body.preparing).toContain(order.body.number);

    await put(cashier, '/queue/tv', { paused: false }).expect(200);
    expect(
      (await tv.get('/api/queue/display').expect(200)).body.paused,
    ).toBe(false);
    const actions = await ctx.db.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'queue.tv.' } },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(actions.map((entry) => entry.action)).toEqual([
      'queue.tv.pause',
      'queue.tv.resume',
    ]);
  });
});
