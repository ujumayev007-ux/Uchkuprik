import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs } from '../src/printing/queue.js';
import { createEventBus } from '../src/realtime/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
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
const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!;

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = tenant.branch;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const category = await post(owner, '/menu/categories', {
    name: 'Taomlar',
  }).expect(201);
  const osh = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Osh',
    variants: [{ name: 'Standart', price: 35000 }],
  }).expect(201);
  const somsa = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Somsa',
    variants: [{ name: 'Standart', price: 8000 }],
  }).expect(201);
  const variants = await ctx.db.productVariant.findMany({
    where: { tenantId, productId: { in: [osh.body.id, somsa.body.id] } },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: branch.id, name: 'Zal' },
  });
  const table = await ctx.db.diningTable.create({
    data: {
      tenantId,
      branchId: branch.id,
      roomId: room.id,
      name: '7-stol',
      qrToken: unique('qr'),
    },
  });
  for (const username of ['ofitsiant', 'ofitsiant2'])
    await addUser(ctx, tenantId, {
      username,
      roleIds: [tenant.roleId('waiter')],
    });
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  const waiter = ctx.agent();
  const waiterLogin = await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  const other = ctx.agent();
  const otherLogin = await login(other, tenant.slug, 'ofitsiant2').expect(200);
  const cook = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  return {
    tenant,
    owner,
    waiter,
    other,
    cook,
    table,
    waiterCookie: cookieOf(waiterLogin),
    otherCookie: cookieOf(otherLogin),
    osh: variants.find((v) => v.productId === osh.body.id)!,
    somsa: variants.find((v) => v.productId === somsa.body.id)!,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The waiter's order for table 7: 2 × osh and 3 × somsa, sent to the kitchen. */
async function order(s: Setup) {
  const created = await post(s.waiter, '/orders', {
    idempotencyKey: randomUUID(),
    type: 'DINE_IN',
    tableId: s.table.id,
    place: true,
    items: [
      { variantId: s.osh.id, quantity: 2 },
      { variantId: s.somsa.id, quantity: 3 },
    ],
  }).expect(201);
  let body = created.body;
  if (body.status === 'PENDING')
    body = (await post(s.owner, `/orders/${body.id}/approve`).expect(200)).body;
  await post(s.cook, `/kitchen/orders/${body.id}/accept`);
  const items = await ctx.db.orderItem.findMany({
    where: { orderId: body.id },
  });
  const itemOf = (variantId: string) =>
    items.find((item) => item.variantId === variantId)!;
  return { id: body.id as string, number: body.number as number, itemOf };
}

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

/** Reads the Android alert stream (SSE) of a session until `until` events arrived. */
async function streamEvents(
  cookie: string,
  act: () => Promise<void>,
  until: (
    events: { event: string; data: Record<string, unknown> }[],
  ) => boolean,
) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/live/alerts`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let buffer = '';
  let acted = false;
  const deadline = Date.now() + 8_000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
      // The stream is open (config arrived): now the kitchen acts.
      if (!acted && events.some((e) => e.event === 'readySnapshot')) {
        acted = true;
        void act();
      }
      if (acted && until(events)) break;
    }
  } finally {
    abort.abort();
  }
  return events;
}

describe('«Tayyor» alerts for the waiter of the order', () => {
  it('osh ready → only osh is announced; somsa later → a separate alert, then «to‘liq tayyor»', async () => {
    const s = await setup();
    const o = await order(s);
    const mine = await socketFor(s.waiterCookie);
    const theirs = await socketFor(s.otherCookie);
    const received: Record<string, unknown>[] = [];
    const strangers: unknown[] = [];
    mine.on('order.items_ready', (payload) => received.push(payload));
    theirs.on('order.items_ready', (payload) => strangers.push(payload));

    const oshItem = o.itemOf(s.osh.id);
    const somsaItem = o.itemOf(s.somsa.id);
    await post(s.cook, `/kitchen/items/${oshItem.id}/status`, {
      status: 'READY',
    }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      orderId: o.id,
      number: o.number,
      table: '7-stol',
      branchId: s.tenant.branch.id,
      items: [{ id: oshItem.id, name: 'Osh', quantity: 2 }],
      allReady: false,
    });
    // The somsa is still being prepared.
    const stillCooking = await ctx.db.orderItem.findUniqueOrThrow({
      where: { id: somsaItem.id },
    });
    expect(stillCooking.kitchenStatus).not.toBe('READY');
    // Marking the osh ready again announces nothing new.
    await post(s.cook, `/kitchen/items/${oshItem.id}/status`, {
      status: 'READY',
    });
    await post(s.cook, `/kitchen/items/${somsaItem.id}/status`, {
      status: 'READY',
    }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      items: [{ id: somsaItem.id, name: 'Somsa', quantity: 3 }],
      allReady: true,
    });
    // Another waiter of the same branch hears nothing about this order.
    expect(strangers).toEqual([]);
    mine.close();
    theirs.close();
  });

  it('the Android alert stream sends «ready» only to the order’s waiter, and missed ones on connect', async () => {
    const s = await setup();
    const o = await order(s);
    const oshItem = o.itemOf(s.osh.id);
    const events = await streamEvents(
      s.waiterCookie,
      async () => {
        await post(s.cook, `/kitchen/items/${oshItem.id}/status`, {
          status: 'READY',
        });
      },
      (list) => list.some((e) => e.event === 'ready'),
    );
    const ready = events.find((e) => e.event === 'ready');
    expect(ready?.data).toMatchObject({
      orderId: o.id,
      table: '7-stol',
      items: [{ id: oshItem.id, name: 'Osh', quantity: 2 }],
      allReady: false,
    });
    // Another waiter's stream gets nothing; a reconnect lists the ready dish once.
    const theirs = await streamEvents(
      s.otherCookie,
      async () => undefined,
      () => true,
    );
    expect(theirs.some((e) => e.event === 'ready')).toBe(false);
    expect(theirs.find((e) => e.event === 'readySnapshot')?.data).toEqual({
      items: [],
    });
    const again = await streamEvents(
      s.waiterCookie,
      async () => undefined,
      () => true,
    );
    expect(
      (
        again.find((e) => e.event === 'readySnapshot')?.data.items as {
          id: string;
        }[]
      ).map((item) => item.id),
    ).toEqual([oshItem.id]);
  });

  it('«Tayyor» list and «Olib ketildi» (twice is harmless); all picked up → served', async () => {
    const s = await setup();
    const o = await order(s);
    await post(s.cook, `/kitchen/orders/${o.id}/bump`, {
      status: 'READY',
    }).expect(200);
    const list = await s.waiter.get('/api/waiter/ready-items').expect(200);
    expect(
      list.body.items.map((i: { name: string; table: string }) => [
        i.name,
        i.table,
      ]),
    ).toEqual([
      ['Osh', '7-stol'],
      ['Somsa', '7-stol'],
    ]);
    // Another waiter's list is empty.
    const theirs = await s.other.get('/api/waiter/ready-items').expect(200);
    expect(theirs.body.items).toEqual([]);
    const oshItem = o.itemOf(s.osh.id);
    const first = await post(s.waiter, `/orders/${o.id}/items/picked-up`, {
      itemIds: [oshItem.id],
    }).expect(200);
    expect(first.body.changed).toBe(1);
    const twice = await post(s.waiter, `/orders/${o.id}/items/picked-up`, {
      itemIds: [oshItem.id],
    }).expect(200);
    expect(twice.body.changed).toBe(0);
    await post(s.waiter, `/orders/${o.id}/items/picked-up`, {
      itemIds: [o.itemOf(s.somsa.id).id],
    }).expect(200);
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe('SERVED');
    expect(
      (await s.waiter.get('/api/waiter/ready-items').expect(200)).body.items,
    ).toEqual([]);
  });
});

describe('«Oshxonaga chop etish» from the waiter app', () => {
  it('new / added / cancelled / double tap / reprint «QAYTA CHOP ETILDI» / printer offline', async () => {
    const s = await setup();
    const received: Buffer[] = [];
    const tcp = createTcpServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => received.push(Buffer.concat(chunks)));
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const port = (tcp.address() as AddressInfo).port;
    const printer = await ctx.db.printer.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        name: 'Oshxona printeri',
        kind: 'KITCHEN',
        host: '127.0.0.1',
        port,
      },
    });
    const o = await order(s);
    const jobsOf = () =>
      ctx.db.printJob.findMany({
        where: { orderId: o.id, kind: 'KITCHEN' },
        orderBy: { createdAt: 'asc' },
      });
    // Placing printed the new ticket once; pressing the button twice adds nothing.
    await post(s.waiter, `/orders/${o.id}/kitchen-print`).expect(200);
    const tap = await post(s.waiter, `/orders/${o.id}/kitchen-print`).expect(
      200,
    );
    expect(tap.body.jobs).toBe(0);
    expect((await jobsOf()).map((job) => job.purpose)).toEqual(['NEW']);
    const status1 = await s.waiter
      .get(`/api/orders/${o.id}/kitchen-prints`)
      .expect(200);
    expect(status1.body.jobs[0]).toMatchObject({
      status: 'PENDING',
      purpose: 'NEW',
    });

    // A dish added later prints alone, as an update.
    await post(s.waiter, `/orders/${o.id}/items`, {
      items: [{ variantId: s.somsa.id, quantity: 1, note: 'Piyozsiz' }],
    });
    await post(s.waiter, `/orders/${o.id}/kitchen-print`).expect(200);
    // A cancelled dish prints a cancellation.
    const somsaLine = (
      await ctx.db.orderItem.findMany({
        where: { orderId: o.id, variantId: s.somsa.id },
        orderBy: { createdAt: 'desc' },
      })
    )[0]!;
    await post(s.owner, `/orders/${o.id}/items/${somsaLine.id}/cancel`, {
      reason: 'Mijoz voz kechdi',
      override: true,
    });
    await post(s.waiter, `/orders/${o.id}/kitchen-print`).expect(200);
    // Intentional reprint, tapped twice: one job, marked «QAYTA CHOP ETILDI».
    const reprint = await post(
      s.waiter,
      `/orders/${o.id}/kitchen-reprint`,
    ).expect(200);
    expect(reprint.body.jobs).toBe(1);
    const double = await post(
      s.waiter,
      `/orders/${o.id}/kitchen-reprint`,
    ).expect(200);
    expect(double.body.repeated).toBe(true);
    const purposes = (await jobsOf()).map((job) => job.purpose);
    expect(purposes.filter((p) => p === 'REPRINT')).toHaveLength(1);
    expect(
      purposes.filter((p) => p === 'UPDATE').length,
    ).toBeGreaterThanOrEqual(2);

    await processPrintJobs(ctx.services, 50);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const text = received.map((buffer) => buffer.toString('latin1'));
    const reprinted = text.filter((t) => t.includes('QAYTA CHOP ETILDI'));
    expect(reprinted).toHaveLength(1);
    expect(reprinted[0]).toContain('7-stol');
    expect(text.some((t) => t.includes('DIQQAT! CHEK YANGILANDI'))).toBe(true);
    expect(text.some((t) => t.includes('Piyozsiz'))).toBe(true);
    const sent = await s.waiter
      .get(`/api/orders/${o.id}/kitchen-prints`)
      .expect(200);
    expect(
      sent.body.jobs.every((job: { status: string }) => job.status === 'SENT'),
    ).toBe(true);

    // Printer offline: the job stays in the queue with an error, never claimed printed.
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await ctx.db.printer.update({
      where: { id: printer.id },
      data: { port: 1 },
    });
    await post(s.waiter, `/orders/${o.id}/items`, {
      items: [{ variantId: s.osh.id, quantity: 1 }],
    });
    await post(s.waiter, `/orders/${o.id}/kitchen-print`).expect(200);
    await processPrintJobs(ctx.services, 50);
    const offline = await s.waiter
      .get(`/api/orders/${o.id}/kitchen-prints`)
      .expect(200);
    expect(['PENDING', 'FAILED']).toContain(offline.body.jobs[0].status);
    expect(offline.body.jobs[0].error).toBeTruthy();
  });
});
