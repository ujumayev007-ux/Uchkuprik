import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueueKitchenTickets,
  processPrintJobs,
} from '../src/printing/queue.js';
import { createEventBus } from '../src/realtime/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

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
  const login1 = await login(owner, tenant.slug, 'owner').expect(200);
  const cookie = String(login1.headers['set-cookie']).split(';')[0]!;
  const grill = await post(owner, '/kitchen/stations', {
    name: 'Grill',
  }).expect(201);
  const bar = await post(owner, '/kitchen/stations', { name: 'Bar' }).expect(
    201,
  );
  const burgers = await post(owner, '/menu/categories', {
    name: 'Burgerlar',
    stationId: grill.body.id,
  }).expect(201);
  const drinks = await post(owner, '/menu/categories', {
    name: 'Ichimliklar',
    stationId: bar.body.id,
  }).expect(201);
  const burger = await post(owner, '/menu/products', {
    categoryId: burgers.body.id,
    name: 'Burger',
    prepTimeMinutes: 8,
    variants: [{ name: 'Standart', price: 40000, cost: 15000 }],
  }).expect(201);
  const cola = await post(owner, '/menu/products', {
    categoryId: drinks.body.id,
    name: 'Kola',
    variants: [{ name: 'Standart', price: 10000 }],
  }).expect(201);
  const variants = await ctx.db.productVariant.findMany({
    where: { tenantId, productId: { in: [burger.body.id, cola.body.id] } },
  });
  const burgerVariant = variants.find((v) => v.productId === burger.body.id)!;
  const colaVariant = variants.find((v) => v.productId === cola.body.id)!;
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  const cook = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  return {
    tenant,
    owner,
    cookie,
    cook,
    grill: grill.body.id as string,
    bar: bar.body.id as string,
    burgerVariant,
    colaVariant,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const placeOrder = (s: Setup) =>
  post(s.owner, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'TAKEAWAY',
    place: true,
    items: [
      { variantId: s.burgerVariant.id, quantity: 2 },
      { variantId: s.colaVariant.id, quantity: 1 },
    ],
  }).expect(201);

function socketFor(cookie: string | null, origin = ORIGIN): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(base, {
      path: '/api/realtime',
      transports: ['websocket'],
      extraHeaders: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin },
      reconnection: false,
    });
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

describe('real-time events', () => {
  it('delivers order events only to the same tenant and branch, without amounts', async () => {
    const a = await setup();
    const b = await setup();
    const socketA = await socketFor(a.cookie);
    const socketB = await socketFor(b.cookie);
    const receivedB: unknown[] = [];
    socketB.on('order.changed', (payload) => receivedB.push(payload));
    const event = new Promise<Record<string, unknown>>((resolve) =>
      socketA.once('order.changed', resolve),
    );
    const order = await placeOrder(a);
    const payload = await event;
    expect(payload).toEqual({
      orderId: order.body.id,
      number: order.body.number,
      status: 'PLACED',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedB).toEqual([]);
    socketA.close();
    socketB.close();
  });

  it('rejects unauthenticated and foreign-origin connections', async () => {
    const s = await setup();
    await expect(socketFor(null)).rejects.toThrow();
    await expect(socketFor(s.cookie, 'https://evil.example')).rejects.toThrow();
  });
});

describe('kitchen display and routing', () => {
  it('routes items to stations, hides prices and derives order status from item progress', async () => {
    const s = await setup();
    const order = await placeOrder(s);
    const id = order.body.id;
    const grill = await s.cook
      .get(`/api/kitchen/tickets?stationId=${s.grill}`)
      .expect(200);
    const ticket = grill.body.tickets.find(
      (t: { orderId: string }) => t.orderId === id,
    );
    expect(
      ticket.items.map((i: { productName: string }) => i.productName),
    ).toEqual(['Burger']);
    expect(ticket.items[0].prepTimeMinutes).toBe(8);
    expect(JSON.stringify(grill.body)).not.toMatch(/price|cost|total|amount/i);
    // Kitchen staff cannot read order totals.
    await s.cook.get(`/api/orders/${id}`).expect(403);

    // Cooking cannot start before the cook accepts the ticket.
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'PREPARING',
      stationId: s.grill,
    }).expect(409);
    await post(s.cook, `/kitchen/orders/${id}/accept`).expect(200);
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'PREPARING',
      stationId: s.grill,
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PREPARING');
    await post(s.cook, `/kitchen/orders/${id}/bump`, {
      status: 'READY',
      stationId: s.grill,
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PREPARING');
    const barItem =
      ticket.items.length === 1
        ? (
            await ctx.db.orderItem.findFirstOrThrow({
              where: { orderId: id, stationId: s.bar },
            })
          ).id
        : '';
    await post(s.cook, `/kitchen/items/${barItem}/status`, {
      status: 'READY',
    }).expect(200);
    const ready = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(ready.status).toBe('READY');
    expect(ready.readyAt).not.toBeNull();

    const queue = await s.cook.get('/api/queue').expect(200);
    expect(queue.body.ready.map((r: { number: number }) => r.number)).toContain(
      order.body.number,
    );
    expect(JSON.stringify(queue.body)).not.toMatch(/price|total/i);

    await post(s.owner, `/orders/${id}/serve`).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('SERVED');
    // Adding an item sends the order back to the kitchen.
    await post(s.owner, `/orders/${id}/items`, {
      items: [{ variantId: s.colaVariant.id, quantity: 1 }],
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PREPARING');

    // Rush priority moves the ticket to the front.
    const second = await placeOrder(s);
    await post(s.owner, `/orders/${second.body.id}/priority`, {
      priority: 1,
    }).expect(200);
    const sorted = await s.cook.get('/api/kitchen/tickets').expect(200);
    expect(sorted.body.tickets[0].orderId).toBe(second.body.id);
  });

  it('keeps kitchen stations and tickets tenant-scoped', async () => {
    const a = await setup();
    const b = await setup();
    const order = await placeOrder(a);
    await post(b.cook, `/kitchen/orders/${order.body.id}/bump`, {
      status: 'READY',
    }).expect(404);
    await post(b.owner, '/menu/categories', {
      name: 'X',
      stationId: a.grill,
    }).expect(400);
    const tickets = await b.cook.get('/api/kitchen/tickets').expect(200);
    expect(tickets.body.tickets).toEqual([]);
  });
});

describe('kitchen printing', () => {
  it('prints station tickets once over raw TCP and retries failed jobs', async () => {
    const s = await setup();
    const received: Buffer[] = [];
    const tcp = createTcpServer((socket) =>
      socket.on('data', (chunk) => received.push(chunk)),
    );
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const port = (tcp.address() as AddressInfo).port;

    // The API only accepts private LAN printer addresses (no loopback or metadata hosts).
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '8.8.8.8',
      'printer.local',
    ])
      await post(s.owner, '/printers', {
        branchId: s.tenant.branch.id,
        name: 'X',
        kind: 'KITCHEN',
        host,
        port: 9100,
      }).expect(400);
    await post(s.owner, '/printers', {
      branchId: s.tenant.branch.id,
      name: 'Bar printer',
      kind: 'KITCHEN',
      stationId: s.bar,
      host: '192.168.1.50',
      port: 9100,
    }).expect(201);
    // Test-only printer pointing at the local TCP listener (bypasses the LAN rule).
    const grillPrinter = await ctx.db.printer.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        name: 'Grill printer',
        kind: 'KITCHEN',
        stationId: s.grill,
        host: '127.0.0.1',
        port,
      },
    });
    const bar = await ctx.db.printer.findFirstOrThrow({
      where: { tenantId: s.tenant.tenant.id, name: 'Bar printer' },
    });
    await ctx.db.printer.update({
      where: { id: bar.id },
      data: { host: '127.0.0.1', port: 1 },
    });

    const order = await placeOrder(s);
    await enqueueKitchenTickets(ctx.services, order.body.id);
    await enqueueKitchenTickets(ctx.services, order.body.id); // idempotent: items print once
    const jobs = await ctx.db.printJob.findMany({
      where: { orderId: order.body.id },
    });
    expect(jobs.map((job) => job.printerId).sort()).toEqual(
      [bar.id, grillPrinter.id].sort(),
    );

    await processPrintJobs(ctx.services);
    // The ticket arrives over a real socket: wait for it instead of a fixed pause.
    for (
      let wait = 0;
      wait < 80 &&
      !Buffer.concat(received).toString('latin1').includes('2 x Burger');
      wait++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    const printed = Buffer.concat(received).toString('latin1');
    expect(printed).toContain(`N ${order.body.number}`);
    expect(printed).toContain('2 x Burger');
    expect(printed).not.toContain('Kola');

    const failed = await ctx.db.printJob.findFirstOrThrow({
      where: { printerId: bar.id },
    });
    expect(failed).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(failed.lastError).toBeTruthy();
    const list = await s.owner.get('/api/print-jobs').expect(200);
    expect(
      list.body.jobs.find((job: { id: string }) => job.id === failed.id).status,
    ).toBe('PENDING');
    await post(s.owner, `/print-jobs/${failed.id}/retry`).expect(200);
    tcp.close();
  }, 90_000);
});
