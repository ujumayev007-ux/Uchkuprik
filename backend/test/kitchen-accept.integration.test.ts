import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEventBus } from '../src/realtime/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Kitchen confirmation: "Qabul qilish" is required, recorded once, refusal is permission-
// controlled and every other panel hears about each change.
const ctx = createTestContext();
const bus = createEventBus();
ctx.services.events = bus;
let server: Server;
let base = '';
let realtime: ReturnType<typeof attachRealtime>;

beforeAll(async () => {
  server = createHttpServer(ctx.app);
  realtime = attachRealtime(server, ctx.services, bus, ORIGIN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await realtime.close();
  await new Promise((resolve) => server.close(resolve));
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  const ownerLogin = await login(owner, tenant.slug, 'owner').expect(200);
  const cookie = String(ownerLogin.headers['set-cookie']).split(';')[0]!;
  const category = await post(owner, '/menu/categories', {
    name: 'Taomlar',
  }).expect(201);
  const product = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Osh',
    prepTimeMinutes: 10,
    variants: [{ name: 'Standart', price: 30000 }],
  }).expect(201);
  const variant = await ctx.db.productVariant.findFirstOrThrow({
    where: { tenantId, productId: product.body.id },
  });
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  await addUser(ctx, tenantId, {
    username: 'oshpaz2',
    roleIds: [tenant.roleId('kitchen')],
  });
  const cook = ctx.agent();
  const cook2 = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  await login(cook2, tenant.slug, 'oshpaz2').expect(200);
  return { tenant, tenantId, owner, cookie, cook, cook2, variant };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const placeOrder = (s: Setup) =>
  post(s.owner, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'TAKEAWAY',
    place: true,
    note: 'Achchiq bo‘lmasin',
    items: [{ variantId: s.variant.id, quantity: 3, note: 'Sabzi ko‘p' }],
  }).expect(201);

function socketFor(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(base, {
      path: '/api/realtime',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie, Origin: ORIGIN },
      reconnection: false,
    });
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

describe('kitchen confirmation (Qabul qilish)', () => {
  it('a new ticket shows number, items, quantities, note and time and is not accepted yet', async () => {
    const s = await setup();
    const order = await placeOrder(s);
    const tickets = await s.cook.get('/api/kitchen/tickets').expect(200);
    const ticket = tickets.body.tickets.find(
      (t: { orderId: string }) => t.orderId === order.body.id,
    );
    expect(ticket.number).toBe(order.body.number);
    expect(ticket.placedAt).toBeTruthy();
    expect(ticket.note).toBe('Achchiq bo‘lmasin');
    expect(ticket.items[0]).toMatchObject({
      productName: 'Osh',
      quantity: 3,
      note: 'Sabzi ko‘p',
    });
    expect(ticket.kitchen.acceptedAt).toBeNull();
    expect(ticket.kitchen.rejectedAt).toBeNull();
  });

  it('cooking and "ready" are refused until the cook accepts', async () => {
    const s = await setup();
    const id = (await placeOrder(s)).body.id as string;
    const item = await ctx.db.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });
    for (const status of ['PREPARING', 'READY'] as const) {
      const refused = await post(s.cook, `/kitchen/items/${item.id}/status`, {
        status,
      }).expect(409);
      expect(refused.body.code).toBe('ACCEPT_REQUIRED');
    }
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'PREPARING',
    }).expect(409);
    await post(s.cook, `/kitchen/orders/${id}/accept`).expect(200);
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'PREPARING',
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PREPARING');
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'READY',
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('READY');
  });

  it('is recorded once even when two kitchen screens press at the same moment', async () => {
    const s = await setup();
    const id = (await placeOrder(s)).body.id as string;
    const [a, b] = await Promise.all([
      post(s.cook, `/kitchen/orders/${id}/accept`),
      post(s.cook2, `/kitchen/orders/${id}/accept`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.already, b.body.already].sort()).toEqual([false, true]);
    const events = await ctx.db.orderEvent.findMany({
      where: { orderId: id, type: 'kitchen_accept' },
    });
    expect(events).toHaveLength(1);
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(order.kitchenAcceptedAt).not.toBeNull();
    // A later press only reports who accepted; nothing changes.
    const again = await post(s.cook2, `/kitchen/orders/${id}/accept`).expect(
      200,
    );
    expect(again.body.already).toBe(true);
    expect(again.body.by).toBeTruthy();
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).version,
    ).toBe(order.version);
  });

  it('refusal needs the permission, a reason, stays visible and can be resent', async () => {
    const s = await setup();
    const id = (await placeOrder(s)).body.id as string;
    // A cook without the permission cannot refuse.
    const roleId = s.tenant.roleId('kitchen');
    await ctx.db.role.update({
      where: { id: roleId },
      data: { permissions: ['kitchen.access', 'operations.perform'] },
    });
    const limited = ctx.agent();
    await login(limited, s.tenant.slug, 'oshpaz').expect(200);
    await post(limited, `/kitchen/orders/${id}/reject`, {
      reason: 'Masalliq yo‘q',
    }).expect(403);
    // The restaurant owner holds every permission.
    await post(s.owner, `/kitchen/orders/${id}/reject`, {}).expect(400);
    await post(s.owner, `/kitchen/orders/${id}/reject`, {
      reason: 'Masalliq yo‘q',
    }).expect(200);
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(order.kitchenRejectReason).toBe('Masalliq yo‘q');
    expect(order.status).toBe('PLACED'); // not lost
    // Cooking a refused ticket is not possible; accepting it neither.
    await post(s.cook, `/kitchen/orders/${id}/accept`).expect(409);
    // Cashier view carries the flag.
    const view = await s.owner.get(`/api/orders/${id}`).expect(200);
    expect(view.body.kitchen.rejectReason).toBe('Masalliq yo‘q');
    // Resending clears it.
    await post(s.owner, `/kitchen/orders/${id}/reopen`).expect(200);
    await post(s.cook, `/kitchen/orders/${id}/accept`).expect(200);
    // The refusal is audited.
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, action: 'kitchen.order.reject' },
    });
    expect(audits).toHaveLength(1);
  });

  it('a refused order leaves the customer TV queue', async () => {
    const s = await setup();
    const id = (await placeOrder(s)).body.id as string;
    const before = await s.owner.get('/api/queue').expect(200);
    expect(before.body.preparing).toContain(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).number,
    );
    await post(s.owner, `/kitchen/orders/${id}/reject`, {
      reason: 'Tugagan',
    }).expect(200);
    const after = await s.owner.get('/api/queue').expect(200);
    expect(after.body.preparing).toHaveLength(0);
  });

  it('every change reaches the other panels in real time (kitchen flag, no amounts)', async () => {
    const s = await setup();
    const panel = await socketFor(s.cookie);
    const seen: Record<string, unknown>[] = [];
    panel.on('order.changed', (payload) => seen.push(payload));
    const id = (await placeOrder(s)).body.id as string;
    await post(s.cook, `/kitchen/orders/${id}/accept`).expect(200);
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'PREPARING',
    }).expect(200);
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'READY',
    }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.map((e) => [e.status, e.kitchen])).toEqual(
      expect.arrayContaining([
        ['PLACED', undefined],
        ['PLACED', 'ACCEPTED'],
        ['PREPARING', undefined],
        ['READY', undefined],
      ]),
    );
    expect(JSON.stringify(seen)).not.toMatch(/total|price|amount/i);
    panel.close();
  });

  it('keeps tenants apart', async () => {
    const a = await setup();
    const b = await setup();
    const id = (await placeOrder(a)).body.id as string;
    await post(b.cook, `/kitchen/orders/${id}/accept`).expect(404);
    await post(b.owner, `/kitchen/orders/${id}/reject`, {
      reason: 'Begona',
    }).expect(404);
  });
});
