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

/** Tenant with a burger (2 sizes, required sauce group) and a drink. */
async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const burger = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Burger' },
  });
  const small = await ctx.db.productVariant.create({
    data: {
      tenantId,
      productId: burger.id,
      name: 'Kichik',
      price: 40000,
      cost: 15000,
      sortOrder: 0,
    },
  });
  const large = await ctx.db.productVariant.create({
    data: {
      tenantId,
      productId: burger.id,
      name: 'Katta',
      price: 50000,
      cost: 20000,
      sortOrder: 1,
    },
  });
  const sauces = await ctx.db.modifierGroup.create({
    data: { tenantId, name: 'Sous', minSelect: 1, maxSelect: 2 },
  });
  const ketchup = await ctx.db.modifierOption.create({
    data: { tenantId, groupId: sauces.id, name: 'Ketchup', price: 0 },
  });
  const cheese = await ctx.db.modifierOption.create({
    data: {
      tenantId,
      groupId: sauces.id,
      name: 'Pishloq',
      price: 5000,
      sortOrder: 1,
    },
  });
  await ctx.db.productModifierGroup.create({
    data: { tenantId, productId: burger.id, groupId: sauces.id },
  });
  const drinkProduct = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Kola' },
  });
  const drink = await ctx.db.productVariant.create({
    data: {
      tenantId,
      productId: drinkProduct.id,
      name: '0.5 L',
      price: 10000,
      cost: 4000,
    },
  });
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  return { tenant, owner, cashier, small, large, drink, ketchup, cheese };
}
type Setup = Awaited<ReturnType<typeof setup>>;

// 2 × large burger with cheese (55 000) + 2 × drink (10 000) = 130 000 so‘m.
const orderBody = (s: Setup, extra: object = {}) => ({
  idempotencyKey: randomUUID(),
  type: 'TAKEAWAY',
  items: [
    { variantId: s.large.id, quantity: 2, modifierOptionIds: [s.cheese.id] },
    { variantId: s.drink.id, quantity: 2 },
  ],
  ...extra,
});

const pay = (agent: Agent, orderId: string, body: object) =>
  post(agent, `/orders/${orderId}/payments`, {
    idempotencyKey: randomUUID(),
    ...body,
  });

describe('POS order and cash payment flow', () => {
  it('prices on the server, calculates change, reconciles the shift and produces the Z-report', async () => {
    const s = await setup();
    const created = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      subtotal: 130000,
      total: 130000,
      due: 130000,
      number: 1,
    });
    expect(created.body.items[0]).toMatchObject({
      unitPrice: 50000,
      modifiersTotal: 5000,
      lineTotal: 110000,
    });
    expect(created.body.items[0].unitCost).toBeUndefined();
    const id = created.body.id;

    const noShift = await pay(s.cashier, id, {
      method: 'CASH',
      amount: 130000,
      tendered: 200000,
    });
    expect(noShift.body.code).toBe('SHIFT_REQUIRED');
    await post(s.cashier, '/shifts/open', { openingCash: 100000 }).expect(201);
    expect(
      (await post(s.cashier, '/shifts/open', { openingCash: 5 })).body.code,
    ).toBe('SHIFT_ALREADY_OPEN');

    expect(
      (
        await pay(s.cashier, id, {
          method: 'CASH',
          amount: 130000,
          tendered: 100000,
        })
      ).body.code,
    ).toBe('INSUFFICIENT_CASH');
    expect(
      (
        await pay(s.cashier, id, {
          method: 'CASH',
          amount: 130001,
          tendered: 200000,
        })
      ).body.code,
    ).toBe('AMOUNT_EXCEEDS_DUE');
    expect(
      (await pay(s.cashier, id, { method: 'CLICK', amount: 130000 })).body.code,
    ).toBe('PROVIDER_NOT_CONFIGURED');

    // Total 130 000, received 200 000 -> change 70 000.
    const paid = await pay(s.cashier, id, {
      method: 'CASH',
      amount: 130000,
      tendered: 200000,
    }).expect(201);
    expect(paid.body.change).toBe(70000);
    expect(paid.body.order).toMatchObject({
      status: 'PLACED',
      paidTotal: 130000,
      due: 0,
    });
    await post(s.cashier, `/orders/${id}/complete`).expect(200);

    // Pay-out of 5 000 for supplies, then close with 1 000 short.
    await post(s.cashier, '/shifts/current/movements', {
      amount: -5000,
      reason: 'Paket sotib olindi',
    }).expect(201);
    const current = await s.cashier.get('/api/shifts/current').expect(200);
    expect(current.body.shift.expectedCash).toBe(225000);
    const closed = await post(
      s.cashier,
      `/shifts/${current.body.shift.shift.id}/close`,
      { countedCash: 224000 },
    ).expect(200);
    expect(closed.body).toEqual({ expectedCash: 225000, variance: -1000 });
    const report = await s.cashier
      .get(`/api/shifts/${current.body.shift.shift.id}/report`)
      .expect(200);
    expect(report.body).toMatchObject({
      ordersPaid: 1,
      totalPayments: 130000,
      expectedCash: 225000,
    });
    expect(report.body.shift).toMatchObject({
      status: 'CLOSED',
      countedCash: 224000,
      variance: -1000,
    });
    // A closed shift cannot be closed again, and payments need a new shift.
    expect(
      (
        await post(s.cashier, `/shifts/${current.body.shift.shift.id}/close`, {
          countedCash: 1,
        })
      ).status,
    ).toBe(409);
  });

  it('numbers orders sequentially per branch and day and ignores client prices', async () => {
    const s = await setup();
    const first = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    const second = await post(s.cashier, '/orders', {
      ...orderBody(s),
      items: [{ variantId: s.drink.id, quantity: 1, price: 1, unitPrice: 1 }],
    }).expect(201);
    expect([first.body.number, second.body.number]).toEqual([1, 2]);
    expect(second.body.total).toBe(10000);
  });
});

describe('idempotency and concurrency', () => {
  it('returns the same order and payment for retried requests', async () => {
    const s = await setup();
    const body = orderBody(s);
    const a = await post(s.cashier, '/orders', body).expect(201);
    const b = await post(s.cashier, '/orders', body).expect(200);
    expect(b.body.id).toBe(a.body.id);
    await post(s.cashier, '/shifts/open', { openingCash: 0 }).expect(201);
    const key = randomUUID();
    const payment = {
      idempotencyKey: key,
      method: 'CARD',
      amount: 50000,
      reference: 'SLIP-1',
    };
    const p1 = await post(
      s.cashier,
      `/orders/${a.body.id}/payments`,
      payment,
    ).expect(201);
    const p2 = await post(
      s.cashier,
      `/orders/${a.body.id}/payments`,
      payment,
    ).expect(200);
    expect(p2.body.paymentId).toBe(p1.body.paymentId);
    expect(p2.body.order.paidTotal).toBe(50000);
  });

  it('never accepts two concurrent full payments for the same order', async () => {
    const s = await setup();
    const order = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    await post(s.cashier, '/shifts/open', { openingCash: 0 }).expect(201);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        pay(s.cashier, order.body.id, {
          method: 'CASH',
          amount: 130000,
          tendered: 130000,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const stored = await ctx.db.order.findUniqueOrThrow({
      where: { id: order.body.id },
    });
    expect(stored.paidTotal).toBe(130000);
    expect(
      await ctx.db.payment.count({ where: { orderId: order.body.id } }),
    ).toBe(1);
  });
});

describe('menu rules in orders', () => {
  it('enforces modifier rules, ownership and availability', async () => {
    const s = await setup();
    const missing = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: s.small.id, quantity: 1 }],
    });
    expect(missing.body.code).toBe('INVALID_MODIFIERS');
    const foreign = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [
        {
          variantId: s.drink.id,
          quantity: 1,
          modifierOptionIds: [s.ketchup.id],
        },
      ],
    });
    expect(foreign.body.code).toBe('INVALID_MODIFIERS');
    await ctx.db.branchVariantPrice.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        variantId: s.drink.id,
        isAvailable: false,
      },
    });
    const stopped = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: s.drink.id, quantity: 1 }],
    });
    expect(stopped.body.code).toBe('ITEM_UNAVAILABLE');
    // Another tenant's variant is simply not found for this tenant.
    const other = await setup();
    const cross = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: other.drink.id, quantity: 1 }],
    });
    expect(cross.body.code).toBe('ITEM_UNAVAILABLE');
  });

  it('applies service charge to dine-in orders on a valid table only', async () => {
    const s = await setup();
    await ctx.db.tenantProfile.create({
      data: { tenantId: s.tenant.tenant.id, serviceChargeBp: 1000 },
    });
    const room = await ctx.db.room.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        name: 'Zal',
      },
    });
    const table = await ctx.db.diningTable.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        roomId: room.id,
        name: 'T1',
        qrToken: randomUUID(),
      },
    });
    const order = await post(
      s.cashier,
      '/orders',
      orderBody(s, { type: 'DINE_IN', tableId: table.id }),
    ).expect(201);
    expect(order.body).toMatchObject({
      serviceCharge: 13000,
      total: 143000,
      table: { name: 'T1' },
    });
    const other = await setup();
    const room2 = await ctx.db.room.create({
      data: {
        tenantId: other.tenant.tenant.id,
        branchId: other.tenant.branch.id,
        name: 'Zal',
      },
    });
    const foreignTable = await ctx.db.diningTable.create({
      data: {
        tenantId: other.tenant.tenant.id,
        branchId: other.tenant.branch.id,
        roomId: room2.id,
        name: 'X',
        qrToken: randomUUID(),
      },
    });
    await post(
      s.cashier,
      '/orders',
      orderBody(s, { type: 'DINE_IN', tableId: foreignTable.id }),
    ).expect(400);
  });
});

describe('discounts, cancellations and refunds', () => {
  it('restricts discounts and item cancellation to authorized roles', async () => {
    const s = await setup();
    const order = await post(
      s.cashier,
      '/orders',
      orderBody(s, { place: true }),
    ).expect(201);
    await post(s.cashier, `/orders/${order.body.id}/discount`, {
      percentBp: 1000,
      reason: 'Doimiy mijoz',
    }).expect(403);
    const discounted = await post(
      s.owner,
      `/orders/${order.body.id}/discount`,
      {
        percentBp: 1000,
        reason: 'Doimiy mijoz',
      },
    ).expect(200);
    expect(discounted.body).toMatchObject({
      discountTotal: 13000,
      total: 117000,
    });
    const itemId = order.body.items[1].id;
    // Placed items need orders.cancel (cashiers do not have it by default).
    await post(s.cashier, `/orders/${order.body.id}/items/${itemId}/cancel`, {
      reason: 'Mijoz rad etdi',
    }).expect(403);
    const cancelled = await post(
      s.owner,
      `/orders/${order.body.id}/items/${itemId}/cancel`,
      {
        reason: 'Mijoz rad etdi',
      },
    ).expect(200);
    expect(cancelled.body).toMatchObject({
      subtotal: 110000,
      discountTotal: 11000,
      total: 99000,
    });
  });

  it('refunds only with approval, never beyond the payment, and blocks cancelling paid orders', async () => {
    const s = await setup();
    await post(s.cashier, '/shifts/open', { openingCash: 50000 }).expect(201);
    const order = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    const id = order.body.id;
    const card = await pay(s.cashier, id, {
      method: 'CARD',
      amount: 30000,
    }).expect(201);
    const cash = await pay(s.cashier, id, {
      method: 'CASH',
      amount: 100000,
      tendered: 100000,
    }).expect(201);
    expect(cash.body.order.due).toBe(0);

    // Cancelling an item would leave the order overpaid.
    const overpaid = await post(
      s.owner,
      `/orders/${id}/items/${order.body.items[1].id}/cancel`,
      { reason: 'Xato' },
    );
    expect(overpaid.body.code).toBe('OVERPAID');
    expect(
      (await post(s.owner, `/orders/${id}/cancel`, { reason: 'Mijoz ketdi' }))
        .body.code,
    ).toBe('PAID_ORDER');

    await post(s.cashier, `/orders/${id}/refunds`, {
      paymentId: cash.body.paymentId,
      amount: 10000,
      reason: 'Xato',
    }).expect(403);
    // Owner refunds the cash part from the owner's register shift.
    await post(s.owner, '/shifts/open', { openingCash: 0 }).expect(201);
    const tooMuch = await post(s.owner, `/orders/${id}/refunds`, {
      paymentId: cash.body.paymentId,
      amount: 100001,
      reason: 'Qaytarish',
    });
    expect(tooMuch.body.code).toBe('REFUND_EXCEEDS_PAYMENT');
    await post(s.owner, `/orders/${id}/refunds`, {
      paymentId: cash.body.paymentId,
      amount: 100000,
      reason: 'Qaytarish',
    }).expect(201);
    const cardRefund = await post(s.owner, `/orders/${id}/refunds`, {
      paymentId: card.body.paymentId,
      amount: 30000,
      reason: 'Qaytarish',
    }).expect(201);
    expect(cardRefund.body).toMatchObject({
      paidTotal: 130000,
      refundedTotal: 130000,
      due: 130000,
    });
    await post(s.owner, `/orders/${id}/cancel`, {
      reason: 'Mijoz ketdi',
    }).expect(200);

    // The cash refund leaves the owner's drawer, not the cashier's.
    const ownerShift = await s.owner.get('/api/shifts/current').expect(200);
    expect(ownerShift.body.shift.expectedCash).toBe(-100000);
    const cashierShift = await s.cashier.get('/api/shifts/current').expect(200);
    expect(cashierShift.body.shift.expectedCash).toBe(150000);

    const events = await s.owner.get(`/api/orders/${id}/events`).expect(200);
    expect(
      events.body.events.map((event: { type: string }) => event.type),
    ).toEqual([
      'created',
      'payment',
      'status',
      'payment',
      'refund',
      'refund',
      'status',
    ]);
  });

  it('keeps payment and event records immutable', async () => {
    const s = await setup();
    await post(s.cashier, '/shifts/open', { openingCash: 0 }).expect(201);
    const order = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    await pay(s.cashier, order.body.id, {
      method: 'CARD',
      amount: 1000,
    }).expect(201);
    await expect(
      ctx.db
        .$executeRaw`UPDATE payments SET amount = 1 WHERE "orderId" = ${order.body.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      ctx.db
        .$executeRaw`DELETE FROM order_events WHERE "orderId" = ${order.body.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      ctx.db
        .$executeRaw`UPDATE orders SET "paidTotal" = 999999999 WHERE id = ${order.body.id}::uuid`,
    ).rejects.toThrow();
  });
});

describe('isolation and reports', () => {
  it('hides other tenants’ orders and restricts cost data in reports', async () => {
    const s = await setup();
    await post(s.cashier, '/shifts/open', { openingCash: 0 }).expect(201);
    const order = await post(s.cashier, '/orders', orderBody(s)).expect(201);
    await pay(s.cashier, order.body.id, {
      method: 'CASH',
      amount: 130000,
      tendered: 150000,
    }).expect(201);

    const intruder = await setup();
    await intruder.owner.get(`/api/orders/${order.body.id}`).expect(404);
    await post(intruder.owner, `/orders/${order.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 1,
    }).expect(404);

    await s.cashier.get('/api/reports/sales').expect(403);
    const report = await s.owner.get('/api/reports/sales').expect(200);
    expect(report.body).toMatchObject({
      orders: 1,
      salesTotal: 130000,
      collected: 130000,
      averageCheck: 130000,
    });
    expect(report.body.topProducts[0]).toMatchObject({
      name: 'Burger',
      quantity: 2,
      revenue: 110000,
    });
    // Cost: 2 × 20 000 + 2 × 4 000 = 48 000; profit 82 000.
    expect(report.body.profit).toEqual({
      costOfGoods: 48000,
      grossProfit: 82000,
      marginBp: 6308,
    });

    const managerRole = await post(s.owner, '/roles', {
      name: 'Menejer',
      permissions: ['reports.view'],
    }).expect(201);
    await addUser(ctx, s.tenant.tenant.id, {
      username: 'menejer',
      roleIds: [managerRole.body.id],
    });
    const manager = ctx.agent();
    await login(manager, s.tenant.slug, 'menejer').expect(200);
    const limited = await manager.get('/api/reports/sales').expect(200);
    expect(limited.body.profit).toBeUndefined();
  });
});
