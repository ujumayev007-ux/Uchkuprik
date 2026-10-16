import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/modules/control/keys.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import { createEventBus } from '../src/realtime/bus.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
} from './helpers.js';

// The whole guest journey and the consistency of money across simultaneous edits.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
ctx.services.events = createEventBus();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;

const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup(features: Record<string, unknown> = {}) {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Lavash' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Oddiy', price: 40_000 },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: branch.id, name: 'Zal' },
  });
  const tables = [];
  for (const name of ['1-stol', '2-stol', '3-stol'])
    tables.push(
      await ctx.db.diningTable.create({
        data: {
          tenantId,
          branchId: branch.id,
          roomId: room.id,
          name,
          qrToken: unique('qr'),
        },
      }),
    );
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  await addUser(ctx, tenantId, {
    username: 'ofitsiant',
    roleIds: [tenant.roleId('waiter')],
  });
  const customer = await ctx.db.controlCustomer.create({
    data: { name: unique('Mijoz'), tenantId },
  });
  await ctx.db.controlPolicy.create({
    data: { customerId: customer.id, features: features as object },
  });
  clearPolicyCache();
  clearAdminSettingsCache();
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  await post(cashier, '/shifts/open', { openingCash: 0 }).expect(201);
  return { tenant, tenantId, branch, variant, tables, owner, cashier, waiter };
}

describe('guest journey: cashier → waiter → every panel', () => {
  it('keeps items, payments, history, receipt and reports consistent', async () => {
    const s = await setup();
    const created = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      place: true,
      items: [{ variantId: s.variant.id, quantity: 3 }],
    }).expect(201);
    const id = created.body.id as string;
    expect(created.body.table).toBeNull();
    expect(created.body.total).toBe(120_000);

    // The guest pays part at the counter before sitting down.
    await post(s.cashier, `/orders/${id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 50_000,
      tendered: 50_000,
    }).expect(201);

    // Waiter: table, quantity, note.
    await post(s.waiter, `/orders/${id}/table`, {
      tableId: s.tables[0]!.id,
    }).expect(200);
    const detail = (await s.cashier.get(`/api/orders/${id}`).expect(200)).body;
    const itemId = detail.items[0].id as string;
    await patch(s.waiter, `/orders/${id}/items/${itemId}`, {
      quantity: 2,
      reason: 'Mijoz kamaytirdi',
    }).expect(200);
    await patch(s.waiter, `/orders/${id}`, {
      note: 'Achchiq bo‘lmasin',
    }).expect(200);
    // Owner grants a loyalty discount.
    const discounted = await post(s.owner, `/orders/${id}/discount`, {
      percentBp: 1_000,
      reason: 'Doimiy mijoz',
    }).expect(200);
    // 2 × 40 000 = 80 000, 10 % off = 72 000, 50 000 already paid.
    expect(discounted.body.subtotal).toBe(80_000);
    expect(discounted.body.discountTotal).toBe(8_000);
    expect(discounted.body.total).toBe(72_000);
    expect(discounted.body.due).toBe(22_000);

    // A discount that would leave the order overpaid is refused.
    const overpay = await post(s.owner, `/orders/${id}/discount`, {
      percentBp: 6_000,
      reason: 'Katta chegirma',
    });
    expect(overpay.status).toBe(409);

    // Both panels read the same state.
    for (const agent of [s.cashier, s.waiter, s.owner]) {
      const view = (await agent.get(`/api/orders/${id}`).expect(200)).body;
      expect(view.table.name).toBe('1-stol');
      expect(view.total).toBe(72_000);
      expect(view.due).toBe(22_000);
      expect(view.payments).toHaveLength(1);
    }

    // Pay the rest and finish.
    await post(s.cashier, `/orders/${id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 22_000,
    }).expect(201);
    await post(s.cashier, `/orders/${id}/complete`).expect(200);

    const receipt = (
      await s.cashier.get(`/api/orders/${id}/receipt`).expect(200)
    ).body;
    const printed = receipt.order ?? receipt;
    expect(printed.total).toBe(72_000);
    expect(printed.paidTotal).toBe(72_000);
    expect(printed.table.name).toBe('1-stol');

    const events = (await s.owner.get(`/api/orders/${id}/events`).expect(200))
      .body.events as { type: string }[];
    const types = events.map((event) => event.type);
    for (const type of [
      'created',
      'payment',
      'table_assigned',
      'item_changed',
      'details_updated',
      'discount',
    ])
      expect(types).toContain(type);

    const report = (await s.owner.get('/api/reports/sales').expect(200)).body;
    const text = JSON.stringify(report);
    expect(text).toContain('72000');
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, entityId: id },
    });
    const actions = audits.map((row) => row.action);
    for (const action of [
      'order.table.assign',
      'order.item.change',
      'order.update',
      'order.discount',
    ])
      expect(actions).toContain(action);
  });
});

describe('simultaneous cashier and waiter edits', () => {
  it('serializes changes: totals, payments and versions stay consistent', async () => {
    const s = await setup();
    const created = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      place: true,
      items: [{ variantId: s.variant.id, quantity: 4 }],
    }).expect(201);
    const id = created.body.id as string;
    const itemId = created.body.items[0].id as string;

    const results = await Promise.all([
      patch(s.waiter, `/orders/${id}/items/${itemId}`, {
        quantity: 3,
        reason: 'Kamaytirildi',
      }),
      post(s.owner, `/orders/${id}/discount`, {
        percentBp: 500,
        reason: 'Doimiy mijoz',
      }),
      post(s.waiter, `/orders/${id}/table`, { tableId: s.tables[1]!.id }),
      post(s.cashier, `/orders/${id}/table`, { tableId: s.tables[2]!.id }),
      post(s.cashier, `/orders/${id}/payments`, {
        idempotencyKey: randomUUID(),
        method: 'CASH',
        amount: 20_000,
        tendered: 20_000,
      }),
      patch(s.waiter, `/orders/${id}`, { note: 'Tezroq' }),
    ]);
    // Nothing crashes: every request is either applied or refused cleanly.
    for (const response of results)
      expect([200, 201, 409]).toContain(response.status);
    // None of the independent edits is lost or turns into a server error.
    expect(results.filter((response) => response.status >= 500)).toHaveLength(
      0,
    );

    const finalState = (await s.owner.get(`/api/orders/${id}`).expect(200))
      .body;
    const activeItems = finalState.items.filter(
      (item: { status: string }) => item.status === 'ACTIVE',
    );
    const subtotal = activeItems.reduce(
      (sum: number, item: { lineTotal: number }) => sum + item.lineTotal,
      0,
    );
    expect(finalState.subtotal).toBe(subtotal);
    expect(finalState.total).toBe(
      finalState.subtotal - finalState.discountTotal + finalState.serviceCharge,
    );
    const paid = finalState.payments.reduce(
      (sum: number, payment: { amount: number }) => sum + payment.amount,
      0,
    );
    expect(finalState.paidTotal).toBe(paid);
    expect(finalState.due).toBe(Math.max(0, finalState.total - paid));
    // Exactly one of the two table assignments won; the order has one table.
    expect(['2-stol', '3-stol']).toContain(finalState.table.name);
    const assigned = await ctx.db.orderEvent.count({
      where: { orderId: id, type: 'table_assigned' },
    });
    expect(assigned).toBe(2);
  });
});

describe('permissions are enforced by the backend, per role', () => {
  it('removes editing for a role the Owner switched off, keeping other roles', async () => {
    const s = await setup({
      'orders.edit': { roles: { waiter: { enabled: false } } },
    });
    const created = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      place: true,
      items: [{ variantId: s.variant.id, quantity: 1 }],
    }).expect(201);
    const id = created.body.id as string;
    const itemId = created.body.items[0].id as string;
    const waiterEdit = await patch(s.waiter, `/orders/${id}/items/${itemId}`, {
      quantity: 2,
      reason: 'Sabab bor',
    });
    expect(waiterEdit.status).toBe(403);
    const waiterNote = await patch(s.waiter, `/orders/${id}`, { note: 'x' });
    expect(waiterNote.status).toBe(403);
    // The cashier keeps editing.
    await patch(s.cashier, `/orders/${id}/items/${itemId}`, {
      quantity: 2,
      reason: 'Sabab bor',
    }).expect(200);
  });

  it('switches the waiter alert stream off for a role', async () => {
    const s = await setup({
      'waiter.notify': { roles: { waiter: { enabled: false } } },
    });
    const denied = await s.waiter.get('/api/live/alerts');
    expect(denied.status).toBe(403);
    const me = (await s.waiter.get('/api/auth/me').expect(200)).body;
    expect(me.ordering.waiterAlerts.enabled).toBe(false);
  });

  it('enforces tenant isolation of alerts and table assignment', async () => {
    const a = await setup();
    const b = await setup();
    const created = await post(a.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      place: true,
      items: [{ variantId: a.variant.id, quantity: 1 }],
    }).expect(201);
    const foreign = await post(b.waiter, `/orders/${created.body.id}/table`, {
      tableId: b.tables[0]!.id,
    });
    expect(foreign.status).toBe(404);
    const untouched = (
      await a.cashier.get(`/api/orders/${created.body.id}`).expect(200)
    ).body;
    expect(untouched.table).toBeNull();
  });
});

describe('one active order per table', () => {
  const dineIn = (s: Awaited<ReturnType<typeof setup>>, table: string) => ({
    idempotencyKey: randomUUID(),
    type: 'DINE_IN',
    tableId: table,
    place: true,
    items: [{ variantId: s.variant.id, quantity: 1 }],
  });

  it('restores the order of a reopened table and refuses a duplicate', async () => {
    const s = await setup();
    const table = s.tables[0]!.id;
    const first = await post(s.cashier, '/orders', dineIn(s, table)).expect(
      201,
    );
    const second = await post(s.waiter, '/orders', dineIn(s, table));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TABLE_HAS_ORDER');
    expect(second.body.details.orderId).toBe(first.body.id);

    // Reopening the table finds the same order, which can be extended and edited.
    const found = (
      await s.waiter
        .get(`/api/orders?scope=active&tableId=${table}`)
        .expect(200)
    ).body.orders;
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(first.body.id);
    await post(s.waiter, `/orders/${first.body.id}/items`, {
      items: [{ variantId: s.variant.id, quantity: 2 }],
    }).expect(200);
    const reopened = (
      await s.cashier.get(`/api/orders/${first.body.id}`).expect(200)
    ).body;
    expect(reopened.items).toHaveLength(2);
    const events = await ctx.db.orderEvent.findMany({
      where: { orderId: first.body.id },
    });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['created', 'items_added']),
    );
    expect(await ctx.db.order.count({ where: { tableId: table } })).toBe(1);
  });

  it('serializes simultaneous creation, protects assignment and frees paid tables', async () => {
    const s = await setup();
    const table = s.tables[1]!.id;
    const results = await Promise.all([
      post(s.cashier, '/orders', dineIn(s, table)),
      post(s.waiter, '/orders', dineIn(s, table)),
      post(s.owner, '/orders', dineIn(s, table)),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    const winner = results.find((r) => r.status === 201)!.body;

    // A guest order cannot be moved onto the busy table.
    const guest = await post(s.cashier, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      place: true,
      items: [{ variantId: s.variant.id, quantity: 1 }],
    }).expect(201);
    const busy = await post(s.waiter, `/orders/${guest.body.id}/table`, {
      tableId: table,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('TABLE_HAS_ORDER');
    await post(s.waiter, `/orders/${guest.body.id}/table`, {
      tableId: s.tables[2]!.id,
    }).expect(200);

    // Once the table's order is paid in full the table accepts the next guests.
    await post(s.cashier, `/orders/${winner.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: winner.total,
      tendered: winner.total,
    }).expect(201);
    await post(s.cashier, '/orders', dineIn(s, table)).expect(201);
  });

  it('can be switched off by the Owner for restaurants with split bills', async () => {
    const s = await setup({ 'orders.table.single': { mode: 'OFF' } });
    const table = s.tables[0]!.id;
    await post(s.cashier, '/orders', dineIn(s, table)).expect(201);
    await post(s.cashier, '/orders', dineIn(s, table)).expect(201);
    expect(await ctx.db.order.count({ where: { tableId: table } })).toBe(2);
  });
});
