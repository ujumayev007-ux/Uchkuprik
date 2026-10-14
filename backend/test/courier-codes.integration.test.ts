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

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const category = await post(owner, '/menu/categories', {
    name: 'Fast food',
  }).expect(201);
  const product = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Hot-dog',
    variants: [{ name: 'Standart', price: 20000 }],
  }).expect(201);
  const variant = await ctx.db.productVariant.findFirstOrThrow({
    where: { productId: product.body.id },
  });
  const courierUser = await addUser(ctx, tenantId, {
    username: 'kuryer',
    roleIds: [tenant.roleId('courier')],
  });
  const courier = ctx.agent();
  await login(courier, tenant.slug, 'kuryer').expect(200);
  const order = await post(owner, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'DELIVERY',
    customerPhone: '+998901234567',
    deliveryAddress: 'Yunusobod 4',
    place: true,
    items: [{ variantId: variant.id, quantity: 2 }],
  }).expect(201);
  const id = order.body.id as string;
  await ctx.db.order.update({ where: { id }, data: { status: 'READY' } });
  await post(owner, `/orders/${id}/courier`, {
    courierId: courierUser.id,
  }).expect(200);
  return { tenantId, owner, courier, id };
}

describe('two-stage delivery verification', () => {
  it('hands over with the courier code and delivers with the customer code', async () => {
    const s = await setup();
    // The courier cannot just mark the order as picked up.
    await post(s.courier, `/courier/orders/${s.id}/pickup`).expect(409);
    const handoff = await post(
      s.courier,
      `/courier/orders/${s.id}/handoff-code`,
    ).expect(200);
    expect(handoff.body.code).toMatch(/^\d{6}$/);
    const wrong = handoff.body.code === '000000' ? '111111' : '000000';
    const bad = await post(s.owner, `/delivery/orders/${s.id}/handoff`, {
      code: wrong,
    }).expect(400);
    expect(bad.body.details?.attemptsLeft ?? bad.body.attemptsLeft).toBe(4);
    await post(s.owner, `/delivery/orders/${s.id}/handoff`, {
      code: handoff.body.code,
    }).expect(200);
    let order = await ctx.db.order.findUniqueOrThrow({ where: { id: s.id } });
    expect(order.deliveryStatus).toBe('PICKED_UP');
    expect(order.handedOverById).toBeTruthy();

    // The customer code goes to the cashier (no Telegram) — never to the courier.
    const issued = await post(
      s.owner,
      `/delivery/orders/${s.id}/customer-code`,
    ).expect(200);
    expect(issued.body.code).toMatch(/^\d{6}$/);
    const courierView = await s.courier.get('/api/courier/orders').expect(200);
    expect(JSON.stringify(courierView.body)).not.toContain(issued.body.code);

    await post(s.courier, `/courier/orders/${s.id}/on-the-way`).expect(200);
    await post(s.courier, `/courier/orders/${s.id}/deliver`, {
      code: issued.body.code === '000000' ? '111111' : '000000',
    }).expect(400);
    await post(s.courier, `/courier/orders/${s.id}/deliver`, {
      code: issued.body.code,
      cashCollected: 40000,
    }).expect(200);
    order = await ctx.db.order.findUniqueOrThrow({ where: { id: s.id } });
    expect(order.deliveryStatus).toBe('DELIVERED');
    // Delivery does not mean payment: unpaid order stays open until the cashier books it.
    expect(order.status).not.toBe('COMPLETED');
    expect(order.paidTotal).toBe(0);
    expect(order.cashCollected).toBe(40000);

    await post(s.owner, `/delivery/orders/${s.id}/reconcile`, {
      amount: 30000,
    }).expect(409);
    await post(s.owner, `/delivery/orders/${s.id}/reconcile`, {
      amount: 40000,
    }).expect(200);
    const audit = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, entityId: s.id },
    });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'delivery.handoff',
        'delivery.code.issue',
        'delivery.cash.reconcile',
      ]),
    );
    // Searchable history: by order number, with the actor's role and session.
    const number = (
      await ctx.db.order.findUniqueOrThrow({ where: { id: s.id } })
    ).number;
    const history = await s.owner
      .get(`/api/audit-logs?orderNumber=${number}`)
      .expect(200);
    const handoffRow = history.body.entries.find(
      (entry: { action: string }) => entry.action === 'delivery.handoff',
    );
    expect(handoffRow.roles).toContain('owner');
    expect(handoffRow.session).toBeTruthy();
    // Codes are never stored or logged in plain text.
    const auditText = JSON.stringify(audit, (_key, value) =>
      typeof value === 'bigint' ? String(value) : value,
    );
    expect(auditText).not.toContain(issued.body.code);
    expect(auditText).not.toContain(handoff.body.code);
  });

  it('locks a code after too many wrong attempts', async () => {
    const s = await setup();
    const handoff = await post(
      s.courier,
      `/courier/orders/${s.id}/handoff-code`,
    ).expect(200);
    const wrong = handoff.body.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await post(s.owner, `/delivery/orders/${s.id}/handoff`, {
        code: wrong,
      }).expect(400);
    await post(s.owner, `/delivery/orders/${s.id}/handoff`, {
      code: handoff.body.code,
    }).expect(429);
  });
});
