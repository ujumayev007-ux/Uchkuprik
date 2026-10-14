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
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Lavash' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Standart', price: 20000 },
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
  const zone = await post(owner, '/delivery/zones', {
    branchId: tenant.branch.id,
    name: 'Chilonzor',
    fee: 10000,
    minOrder: 30000,
    etaMinutes: 40,
  }).expect(201);
  const couriers = [];
  for (const username of ['kuryer1', 'kuryer2']) {
    const user = await addUser(ctx, tenantId, {
      username,
      roleIds: [tenant.roleId('courier')],
    });
    const agent = ctx.agent();
    await login(agent, tenant.slug, username).expect(200);
    couriers.push({ user, agent });
  }
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  // These tests cover the simple flow; code verification has its own suite.
  await put(owner, '/settings/orders', { deliveryCodes: false }).expect(200);
  return {
    tenant,
    tenantId,
    owner,
    variant,
    zoneId: zone.body.id as string,
    couriers,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function deliveryOrder(s: Setup, quantity = 2) {
  const order = await post(s.owner, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'DELIVERY',
    customerPhone: '+998901234567',
    deliveryAddress: 'Chilonzor 12',
    place: true,
    items: [{ variantId: s.variant.id, quantity }],
  }).expect(201);
  return order.body.id as string;
}
const markReady = (id: string) =>
  ctx.db.order.update({ where: { id }, data: { status: 'READY' } }).then(() =>
    ctx.db.orderItem.updateMany({
      where: { orderId: id },
      data: { kitchenStatus: 'READY' },
    }),
  );

describe('delivery zones and dispatch', () => {
  it('adds the zone fee, enforces the zone minimum and assigns only couriers', async () => {
    const s = await setup();
    const small = await deliveryOrder(s, 1);
    expect(
      (
        await post(s.owner, `/orders/${small}/delivery-zone`, {
          zoneId: s.zoneId,
        })
      ).body.code,
    ).toBe('ZONE_MIN_ORDER');
    const id = await deliveryOrder(s, 2);
    await post(s.owner, `/orders/${id}/delivery-zone`, {
      zoneId: s.zoneId,
    }).expect(200);
    expect(
      await ctx.db.order.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ subtotal: 40000, deliveryFee: 10000, total: 50000 });

    const cashier = await ctx.db.user.findFirstOrThrow({
      where: { tenantId: s.tenantId, username: 'kassir' },
    });
    await post(s.owner, `/orders/${id}/courier`, {
      courierId: cashier.id,
    }).expect(400);
    await post(s.owner, `/orders/${id}/courier`, {
      courierId: s.couriers[0]!.user.id,
    }).expect(200);
    const board = await s.owner.get('/api/delivery/board').expect(200);
    expect(
      board.body.orders.find((o: { id: string }) => o.id === id),
    ).toMatchObject({
      deliveryStatus: 'ASSIGNED',
      zone: 'Chilonzor',
      due: 50000,
    });
    expect(
      board.body.couriers.map((c: { name: string }) => c.name).sort(),
    ).toEqual(['kuryer1', 'kuryer2']);
  });
});

describe('courier workflow', () => {
  it('picks up only ready orders and completes paid orders on delivery', async () => {
    const s = await setup();
    const [first, second] = s.couriers;
    const id = await deliveryOrder(s);
    await post(s.owner, `/orders/${id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 40000,
    }).expect(201);
    await post(s.owner, `/orders/${id}/courier`, {
      courierId: first!.user.id,
    }).expect(200);

    const mine = await first!.agent.get('/api/courier/orders').expect(200);
    expect(mine.body.orders.map((o: { id: string }) => o.id)).toEqual([id]);
    expect(JSON.stringify(mine.body)).not.toMatch(/cost/i);
    expect(
      (await second!.agent.get('/api/courier/orders').expect(200)).body.orders,
    ).toEqual([]);
    await post(second!.agent, `/courier/orders/${id}/pickup`).expect(404);

    expect(
      (await post(first!.agent, `/courier/orders/${id}/pickup`)).body.code,
    ).toBe('ORDER_NOT_READY');
    await markReady(id);
    await post(first!.agent, `/courier/orders/${id}/pickup`).expect(200);
    expect(
      await ctx.db.order.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'SERVED', deliveryStatus: 'PICKED_UP' });
    const delivered = await post(
      first!.agent,
      `/courier/orders/${id}/deliver`,
      { proof: 'Mijoz qabul qildi' },
    ).expect(200);
    expect(delivered.body.completed).toBe(true);
    expect(
      await ctx.db.order.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      deliveryStatus: 'DELIVERED',
      deliveryProof: 'Mijoz qabul qildi',
    });
    expect(await ctx.db.fiscalReceipt.count({ where: { orderId: id } })).toBe(
      1,
    );
  });

  it('hands unpaid deliveries back to the cashier and records failures', async () => {
    const s = await setup();
    const [first] = s.couriers;
    const unpaid = await deliveryOrder(s);
    await post(s.owner, `/orders/${unpaid}/courier`, {
      courierId: first!.user.id,
    }).expect(200);
    await markReady(unpaid);
    await post(first!.agent, `/courier/orders/${unpaid}/pickup`).expect(200);
    const delivered = await post(
      first!.agent,
      `/courier/orders/${unpaid}/deliver`,
      { proof: 'Naqd 40 000' },
    ).expect(200);
    expect(delivered.body.completed).toBe(false);
    // Cash collected by the courier is recorded by the cashier on their shift.
    await post(s.owner, `/orders/${unpaid}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 40000,
      tendered: 40000,
    }).expect(201);
    await post(s.owner, `/orders/${unpaid}/complete`).expect(200);

    const failed = await deliveryOrder(s);
    await post(s.owner, `/orders/${failed}/courier`, {
      courierId: first!.user.id,
    }).expect(200);
    await post(first!.agent, `/courier/orders/${failed}/fail`, {
      reason: 'Mijoz telefonni ko‘tarmadi',
    }).expect(200);
    const board = await s.owner.get('/api/delivery/board').expect(200);
    expect(
      board.body.orders.find((o: { id: string }) => o.id === failed),
    ).toMatchObject({
      deliveryStatus: 'FAILED',
      failReason: 'Mijoz telefonni ko‘tarmadi',
    });

    const today = new Date().toISOString().slice(0, 10);
    const report = await s.owner
      .get(`/api/delivery/report?from=${today}&to=${today}`)
      .expect(200);
    expect(report.body.couriers).toEqual([
      expect.objectContaining({
        name: 'kuryer1',
        delivered: 1,
        failed: 1,
        deliveryFees: 0,
      }),
    ]);
  });

  it('stores courier location only with consent and erases it when consent is withdrawn', async () => {
    const s = await setup();
    const [first] = s.couriers;
    expect(
      (await post(first!.agent, '/courier/location', { lat: 41.3, lng: 69.24 }))
        .body.code,
    ).toBe('CONSENT_REQUIRED');
    await put(first!.agent, '/courier/consent', { consent: true }).expect(200);
    await post(first!.agent, '/courier/location', {
      lat: 41.3,
      lng: 69.24,
      accuracy: 12,
    }).expect(200);
    let board = await s.owner.get('/api/delivery/board').expect(200);
    expect(
      board.body.couriers.find((c: { id: string }) => c.id === first!.user.id)
        .location,
    ).toMatchObject({ lat: 41.3, lng: 69.24 });
    await put(first!.agent, '/courier/consent', { consent: false }).expect(200);
    const profile = await ctx.db.courierProfile.findUniqueOrThrow({
      where: { userId: first!.user.id },
    });
    expect(profile).toMatchObject({
      locationConsent: false,
      lat: null,
      lng: null,
    });
    board = await s.owner.get('/api/delivery/board').expect(200);
    expect(
      board.body.couriers.find((c: { id: string }) => c.id === first!.user.id)
        .location,
    ).toBeNull();
  });
});

describe('website delivery zones', () => {
  it('requires a zone when the branch has zones and adds its fee', async () => {
    const s = await setup();
    await ctx.db.tenantProfile.upsert({
      where: { tenantId: s.tenantId },
      update: { publicOrdering: true },
      create: { tenantId: s.tenantId, publicOrdering: true },
    });
    const menu = await ctx
      .agent()
      .get(`/api/public/r/${s.tenant.slug}/menu?branchId=${s.tenant.branch.id}`)
      .expect(200);
    expect(menu.body.zones).toEqual([
      expect.objectContaining({ name: 'Chilonzor', fee: 10000 }),
    ]);
    const body = (zoneId?: string) => ({
      idempotencyKey: randomUUID(),
      source: {
        kind: 'web',
        slug: s.tenant.slug,
        branchId: s.tenant.branch.id,
        type: 'DELIVERY',
        ...(zoneId ? { zoneId } : {}),
      },
      customerName: 'Mijoz',
      customerPhone: '+998901234567',
      deliveryAddress: 'Chilonzor 5',
      items: [{ variantId: s.variant.id, quantity: 2 }],
    });
    await post(ctx.agent(), '/public/orders', body()).expect(400);
    const created = await post(
      ctx.agent(),
      '/public/orders',
      body(s.zoneId),
    ).expect(201);
    const tracking = await ctx
      .agent()
      .get(`/api/public/orders/${created.body.trackingToken}`)
      .expect(200);
    expect(tracking.body.total).toBe(50000);
  });
});
