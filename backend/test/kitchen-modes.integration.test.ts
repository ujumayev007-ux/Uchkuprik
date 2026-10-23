import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultPolicy } from '../src/modules/control/policy.js';
import { unlinkedView } from '../src/modules/control/view.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Kitchen modes chosen centrally (Owner, or the Admin where delegated):
// current (unchanged), all orders (no category filter), automatic (self-accept, and
// «Tayyor» hands a fully paid order over through the cashier's completion, once).

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

// The Owner delegated the kitchen mode; the Admin chose `mode`.
function useMode(mode: string | null) {
  if (mode === null) {
    delete ctx.services.controlView;
  } else {
    ctx.services.controlView = async () => {
      const policy = defaultPolicy();
      policy.features['kitchen.mode'] = { mode: 'ADMIN' } as never;
      return {
        ...unlinkedView(),
        policy,
        adminParams: new Map([['kitchen.mode|*', { mode }]]),
      };
    };
  }
}

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const variant = async (category: string, name: string, price: number) => {
    const c = await post(owner, '/menu/categories', { name: category });
    const p = await post(owner, '/menu/products', {
      categoryId: c.body.id,
      name,
      variants: [{ name: 'Standart', price }],
    }).expect(201);
    return (
      await ctx.db.productVariant.findFirstOrThrow({
        where: { productId: p.body.id },
      })
    ).id;
  };
  await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
  const lavash = await variant('Fast Food', 'Lavash', 28000);
  const water = await variant('Ichimliklar', 'Suv', 4000);
  const order = async (variantId: string, pay: boolean) => {
    const created = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId, quantity: 1 }],
    }).expect(201);
    if (pay)
      await post(owner, `/orders/${created.body.id}/payments`, {
        idempotencyKey: randomUUID(),
        method: 'CASH',
        amount: created.body.total,
        tendered: created.body.total,
      }).expect(201);
    return created.body.id as string;
  };
  return { owner, lavash, water, order };
}
const tickets = async (agent: Agent) =>
  (await agent.get('/api/kitchen/tickets').expect(200)).body.tickets as {
    orderId: string;
    kitchen: { acceptedAt: string | null };
  }[];

describe('kitchen modes', () => {
  it('current mode is unchanged; all orders mode shows drinks too', async () => {
    useMode(null);
    const s = await setup();
    const drink = await s.order(s.water, false);
    expect((await tickets(s.owner)).some((t) => t.orderId === drink)).toBe(
      false,
    );
    const me = (await s.owner.get('/api/auth/me')).body;
    expect(me.ordering.kitchen.mode).toBe('current');
    // Accept is still required in the current mode.
    const food = await s.order(s.lavash, false);
    const refused = await post(s.owner, `/kitchen/orders/${food}/bump`, {
      status: 'READY',
    }).expect(409);
    expect(refused.body.code).toBe('ACCEPT_REQUIRED');

    useMode('all');
    expect((await tickets(s.owner)).some((t) => t.orderId === drink)).toBe(
      true,
    );
    useMode(null);
  });

  it('automatic mode: self-accept; «Tayyor» completes a paid order once', async () => {
    useMode('auto');
    const s = await setup();
    const paid = await s.order(s.lavash, true);
    const unpaid = await s.order(s.lavash, false);
    const list = await tickets(s.owner);
    expect(
      list.find((t) => t.orderId === paid)!.kitchen.acceptedAt,
    ).not.toBeNull();

    const ready = await post(s.owner, `/kitchen/orders/${paid}/bump`, {
      status: 'READY',
    }).expect(200);
    expect(ready.body.served).toBe(true);
    const done = await ctx.db.order.findUniqueOrThrow({ where: { id: paid } });
    expect(done.status).toBe('COMPLETED');
    expect(done.paidTotal).toBe(done.total);
    expect(await ctx.db.payment.count({ where: { orderId: paid } })).toBe(1);

    // Not paid yet: stays «Tayyor» for the cashier; nothing completed or charged.
    const waiting = await post(s.owner, `/kitchen/orders/${unpaid}/bump`, {
      status: 'READY',
    }).expect(200);
    expect(waiting.body.served).toBeUndefined();
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id: unpaid } })).status,
    ).toBe('READY');
    // A second «Tayyor» on the completed order changes nothing.
    await post(s.owner, `/kitchen/orders/${paid}/bump`, {
      status: 'READY',
    }).expect(409);
    useMode(null);
  });
});
