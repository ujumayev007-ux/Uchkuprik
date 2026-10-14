import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueKitchenTickets } from '../src/printing/queue.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
const TEST_PRINTERS = ['Grill printer', 'Somsa printer', 'Zaxira'];
// Jobs for unreachable test printers would otherwise stay PENDING and crowd the
// shared print queue used by other test files.
afterAll(async () => {
  await ctx.db.printJob.updateMany({
    where: { status: 'PENDING', printer: { name: { in: TEST_PRINTERS } } },
    data: { status: 'FAILED' },
  });
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const station = await post(owner, '/kitchen/stations', {
    name: 'Somsa',
  }).expect(201);
  const category = await post(owner, '/menu/categories', {
    name: 'Somsalar',
    stationId: station.body.id,
  }).expect(201);
  const product = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Somsa',
    variants: [{ name: 'Standart', price: 8000 }],
  }).expect(201);
  const tea = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Choy',
    variants: [{ name: 'Standart', price: 3000 }],
  }).expect(201);
  const variants = await ctx.db.productVariant.findMany({
    where: { tenantId, productId: { in: [product.body.id, tea.body.id] } },
  });
  const somsa = variants.find((v) => v.productId === product.body.id)!;
  const choy = variants.find((v) => v.productId === tea.body.id)!;
  await addUser(ctx, tenantId, {
    username: 'ofitsiant',
    roleIds: [tenant.roleId('waiter')],
  });
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  const cook = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  await ctx.db.printer.create({
    data: {
      tenantId,
      branchId: tenant.branch.id,
      name: 'Somsa printer',
      kind: 'KITCHEN',
      stationId: station.body.id,
      host: '127.0.0.1',
      port: 1,
    },
  });
  const order = await post(waiter, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'DINE_IN',
    place: true,
    items: [
      { variantId: somsa.id, quantity: 2 },
      { variantId: choy.id, quantity: 1 },
    ],
  }).expect(201);
  await enqueueKitchenTickets(ctx.services, order.body.id);
  const item = (name: string) =>
    order.body.items.find(
      (line: { productName: string }) => line.productName === name,
    ).id as string;
  return { tenant, owner, waiter, cook, order: order.body, item };
}

const lastTicket = async (orderId: string) => {
  const job = await ctx.db.printJob.findFirstOrThrow({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });
  return {
    purpose: job.purpose,
    text: Buffer.from(job.payload).toString('latin1'),
  };
};

describe('order editing and versions', () => {
  it('lets waiters change a sent order and prints only the change', async () => {
    const s = await setup();
    const changed = await patch(
      s.waiter,
      `/orders/${s.order.id}/items/${s.item('Somsa')}`,
      { quantity: 3, reason: 'Mehmon qo‘shildi' },
    ).expect(200);
    expect(changed.body.version).toBeGreaterThan(s.order.version);
    const lines = await ctx.db.orderItem.findMany({
      where: { orderId: s.order.id, productName: 'Somsa' },
      orderBy: { createdAt: 'asc' },
    });
    expect(lines.map((line) => [line.status, line.quantity])).toEqual([
      ['CANCELLED', 2],
      ['ACTIVE', 3],
    ]);
    await enqueueKitchenTickets(ctx.services, s.order.id);
    const ticket = await lastTicket(s.order.id);
    expect(ticket.purpose).toBe('UPDATE');
    expect(ticket.text).toContain('--2-x-Somsa-- BEKOR');
    expect(ticket.text).toContain('3 x Somsa');
    expect(ticket.text).not.toContain('Choy');
    // A reason is required once the kitchen has the order.
    await patch(s.waiter, `/orders/${s.order.id}/items/${s.item('Choy')}`, {
      quantity: 2,
    }).expect(400);
    // The restaurant can forbid waiter edits after sending.
    await put(s.owner, '/settings/orders', {
      waiterCanEditPlaced: false,
    }).expect(200);
    await post(
      s.waiter,
      `/orders/${s.order.id}/items/${s.item('Choy')}/cancel`,
      {
        reason: 'Kerak emas',
      },
    ).expect(403);
  });

  it('asks the kitchen before cancelling an item that is being prepared', async () => {
    const s = await setup();
    // Waiters cannot cancel sent items by default; this restaurant allows it.
    await post(
      s.waiter,
      `/orders/${s.order.id}/items/${s.item('Somsa')}/cancel`,
      { reason: 'Sinov' },
    ).expect(403);
    await put(s.owner, '/settings/orders', {
      staffCanCancelPlaced: true,
    }).expect(200);
    await post(s.cook, `/kitchen/items/${s.item('Somsa')}/status`, {
      status: 'PREPARING',
    }).expect(200);
    const asked = await post(
      s.waiter,
      `/orders/${s.order.id}/items/${s.item('Somsa')}/cancel`,
      { reason: 'Mijoz ketdi' },
    ).expect(202);
    expect(asked.body.cancelRequested).toBe(true);
    const tickets = await s.cook.get('/api/kitchen/tickets').expect(200);
    const line = tickets.body.tickets[0].items.find(
      (item: { id: string }) => item.id === s.item('Somsa'),
    );
    expect(line.cancelRequested).toEqual({ reason: 'Mijoz ketdi' });
    await post(s.cook, `/kitchen/items/${s.item('Somsa')}/cancel-request`, {
      accept: true,
    }).expect(200);
    const item = await ctx.db.orderItem.findUniqueOrThrow({
      where: { id: s.item('Somsa') },
    });
    expect(item.status).toBe('CANCELLED');
    await enqueueKitchenTickets(ctx.services, s.order.id);
    expect((await lastTicket(s.order.id)).text).toContain('BEKOR');
    // A manager can override without waiting for the kitchen.
    await post(s.cook, `/kitchen/items/${s.item('Choy')}/status`, {
      status: 'PREPARING',
    }).expect(200);
    await post(
      s.owner,
      `/orders/${s.order.id}/items/${s.item('Choy')}/cancel`,
      {
        reason: 'Menejer qarori',
        override: true,
      },
    ).expect(200);
    const events = await ctx.db.orderEvent.findMany({
      where: { orderId: s.order.id },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['item_cancel_requested', 'item_cancelled']),
    );
  });

  it('cancels an unpaid order while cooking and tells the kitchen', async () => {
    const s = await setup();
    await post(s.cook, `/kitchen/items/${s.item('Somsa')}/status`, {
      status: 'PREPARING',
    }).expect(200);
    await post(s.owner, `/orders/${s.order.id}/cancel`, {
      reason: 'Mijoz rad etdi',
    }).expect(200);
    const order = await ctx.db.order.findUniqueOrThrow({
      where: { id: s.order.id },
    });
    expect(order.status).toBe('CANCELLED');
    await enqueueKitchenTickets(ctx.services, s.order.id);
    const ticket = await lastTicket(s.order.id);
    expect(ticket.text).toContain('DIQQAT! CHEK YANGILANDI');
    expect(ticket.text).toContain('--2-x-Somsa-- BEKOR');
    expect(ticket.text).toContain('--1-x-Choy-- BEKOR');
  });
});
