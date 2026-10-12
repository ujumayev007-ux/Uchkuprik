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

async function setup(enable = true) {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  if (enable)
    await ctx.db.tenantProfile.create({
      data: { tenantId, publicOrdering: true },
    });
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Burgerlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Burger' },
  });
  const variant = await ctx.db.productVariant.create({
    data: {
      tenantId,
      productId: product.id,
      name: 'Standart',
      price: 40000,
      cost: 15000,
    },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: tenant.branch.id, name: 'Zal' },
  });
  const table = await ctx.db.diningTable.create({
    data: {
      tenantId,
      branchId: tenant.branch.id,
      roomId: room.id,
      name: 'T5',
      qrToken: `qr${randomUUID().replace(/-/g, '')}`,
    },
  });
  await addUser(ctx, tenantId, {
    username: 'ofitsiant',
    roleIds: [tenant.roleId('waiter')],
  });
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  return { tenant, tenantId, variant, table, waiter, owner };
}

const tableOrder = (
  s: Awaited<ReturnType<typeof setup>>,
  extra: object = {},
) => ({
  idempotencyKey: randomUUID(),
  source: { kind: 'table', token: s.table.qrToken },
  customerName: 'Mehmon',
  items: [{ variantId: s.variant.id, quantity: 2, price: 1 }],
  ...extra,
});

describe('public storefront', () => {
  it('is unavailable until the owner enables online ordering', async () => {
    const s = await setup(false);
    const guest = ctx.agent();
    await guest.get(`/api/public/r/${s.tenant.slug}`).expect(404);
    await guest.get(`/api/public/t/${s.table.qrToken}`).expect(404);
    await post(guest, '/public/orders', tableOrder(s)).expect(404);
  });

  it('serves the table menu without costs or unavailable items', async () => {
    const s = await setup();
    const guest = ctx.agent();
    const menu = await guest
      .get(`/api/public/t/${s.table.qrToken}`)
      .expect(200);
    expect(menu.body.table).toEqual({ name: 'T5', room: 'Zal' });
    expect(menu.body.menu.products[0].variants).toEqual([
      { id: s.variant.id, name: 'Standart', price: 40000 },
    ]);
    expect(JSON.stringify(menu.body)).not.toMatch(/cost|tenantId/i);
    await ctx.db.branchVariantPrice.create({
      data: {
        tenantId: s.tenantId,
        branchId: s.tenant.branch.id,
        variantId: s.variant.id,
        isAvailable: false,
      },
    });
    const stopped = await guest
      .get(`/api/public/t/${s.table.qrToken}`)
      .expect(200);
    expect(stopped.body.menu.products).toEqual([]);
    expect((await post(guest, '/public/orders', tableOrder(s))).body.code).toBe(
      'ITEM_UNAVAILABLE',
    );
  });
});

describe('online orders', () => {
  it('creates a pending QR order priced on the server that staff approve into the kitchen', async () => {
    const s = await setup();
    const guest = ctx.agent();
    const body = tableOrder(s);
    const created = await post(guest, '/public/orders', body).expect(201);
    const again = await post(guest, '/public/orders', body).expect(200);
    expect(again.body.trackingToken).toBe(created.body.trackingToken);

    const tracking = await guest
      .get(`/api/public/orders/${created.body.trackingToken}`)
      .expect(200);
    expect(tracking.body).toMatchObject({
      status: 'PENDING',
      type: 'DINE_IN',
      table: 'T5',
      total: 80000,
    });
    expect(JSON.stringify(tracking.body)).not.toMatch(
      /cost|tenantId|createdById/i,
    );

    const order = await ctx.db.order.findFirstOrThrow({
      where: { trackingToken: created.body.trackingToken },
    });
    expect(order).toMatchObject({
      channel: 'QR',
      status: 'PENDING',
      tableId: s.table.id,
    });
    // Money is taken only after approval.
    await post(s.owner, '/shifts/open', { openingCash: 0 }).expect(201);
    const early = await post(s.owner, `/orders/${order.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 80000,
    });
    expect(early.body.code).toBe('INVALID_TRANSITION');

    await post(s.waiter, `/orders/${order.id}/approve`).expect(200);
    await post(s.waiter, `/orders/${order.id}/approve`).expect(409);
    const placed = await guest
      .get(`/api/public/orders/${created.body.trackingToken}`)
      .expect(200);
    expect(placed.body.status).toBe('PLACED');
  });

  it('validates web orders and lets staff reject them with a reason', async () => {
    const s = await setup();
    const guest = ctx.agent();
    const web = (type: string, extra: object = {}) => ({
      idempotencyKey: randomUUID(),
      source: {
        kind: 'web',
        slug: s.tenant.slug,
        branchId: s.tenant.branch.id,
        type,
      },
      customerName: 'Mijoz',
      items: [{ variantId: s.variant.id, quantity: 1 }],
      ...extra,
    });
    await post(guest, '/public/orders', web('TAKEAWAY')).expect(400);
    await post(
      guest,
      '/public/orders',
      web('DELIVERY', { customerPhone: '+998901234567' }),
    ).expect(400);
    const created = await post(
      guest,
      '/public/orders',
      web('DELIVERY', {
        customerPhone: '+998901234567',
        deliveryAddress: 'Chilonzor 5-uy',
      }),
    ).expect(201);
    const order = await ctx.db.order.findFirstOrThrow({
      where: { trackingToken: created.body.trackingToken },
    });
    expect(order).toMatchObject({
      channel: 'WEB',
      type: 'DELIVERY',
      deliveryAddress: 'Chilonzor 5-uy',
    });

    await addUser(ctx, s.tenantId, {
      username: 'oshpaz',
      roleIds: [s.tenant.roleId('kitchen')],
    });
    const cook = ctx.agent();
    await login(cook, s.tenant.slug, 'oshpaz').expect(200);
    await post(cook, `/orders/${order.id}/reject`, {
      reason: 'Yopilish vaqti',
    }).expect(403);
    const tickets = await cook.get('/api/kitchen/tickets').expect(200);
    expect(tickets.body.tickets).toEqual([]);

    await post(s.waiter, `/orders/${order.id}/reject`, {
      reason: 'Yetkazib berish hududidan tashqarida',
    }).expect(200);
    const tracking = await guest
      .get(`/api/public/orders/${created.body.trackingToken}`)
      .expect(200);
    expect(tracking.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Yetkazib berish hududidan tashqarida',
    });
  });

  it('stops accepting orders for rotated QR codes and suspended tenants', async () => {
    const s = await setup();
    const guest = ctx.agent();
    const oldToken = s.table.qrToken;
    await post(s.owner, `/tables/${s.table.id}/rotate-qr`).expect(200);
    await guest.get(`/api/public/t/${oldToken}`).expect(404);
    await post(guest, '/public/orders', tableOrder(s)).expect(404);

    const other = await setup();
    await ctx.db.tenant.update({
      where: { id: other.tenantId },
      data: { status: 'SUSPENDED' },
    });
    await guest.get(`/api/public/r/${other.tenant.slug}`).expect(404);
    await guest.get(`/api/public/orders/${'x'.repeat(24)}`).expect(404);
  });
});
