import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { setDeniedPermissions } from '../src/modules/auth/permissions.js';
import { setLockedOrderSettings } from '../src/modules/orders/settings.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
// Locks are process-wide (one install = one restaurant): reset after each test.
afterEach(() => {
  setDeniedPermissions([]);
  setLockedOrderSettings({});
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('vendor (SUPER_OWNER) control through the licence', () => {
  it('locks order settings so the restaurant admin cannot change them', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    setLockedOrderSettings({
      requireCashierConfirm: true,
      kitchenPrices: false,
    });
    const read = await owner.get('/api/settings/orders').expect(200);
    expect(read.body.settings.requireCashierConfirm).toBe(true);
    expect(read.body.locked).toEqual(
      expect.arrayContaining(['requireCashierConfirm', 'kitchenPrices']),
    );
    const saved = await put(owner, '/settings/orders', {
      requireCashierConfirm: false,
      kitchenPrices: true,
      waiterCanEditPlaced: false,
    }).expect(200);
    // Locked keys keep the vendor's value; free keys follow the admin.
    expect(saved.body.settings).toMatchObject({
      requireCashierConfirm: true,
      kitchenPrices: false,
      waiterCanEditPlaced: false,
    });
    setLockedOrderSettings({});
    const unlocked = await owner.get('/api/settings/orders').expect(200);
    expect(unlocked.body.settings.kitchenPrices).toBe(false);
    expect(unlocked.body.locked).toEqual([]);
  });

  it('removes switched-off permissions from every user, owners included', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    setDeniedPermissions(['orders.cancel', 'discounts.apply']);
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.permissions).not.toContain('orders.cancel');
    expect(me.body.permissions).toContain('orders.create');
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
    }).expect(201);
    await post(owner, `/orders/${order.body.id}/cancel`, {
      reason: 'Sinov uchun',
    }).expect(403);
    setDeniedPermissions([]);
    await post(owner, `/orders/${order.body.id}/cancel`, {
      reason: 'Sinov uchun',
    }).expect(200);
  });
});
