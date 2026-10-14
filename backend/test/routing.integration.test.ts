import { randomUUID } from 'node:crypto';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
  enqueueKitchenTickets,
  processPrintJobs,
} from '../src/printing/queue.js';
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
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const grill = await post(owner, '/kitchen/stations', {
    name: 'Grill',
  }).expect(201);
  const category = await post(owner, '/menu/categories', {
    name: 'Burgerlar',
    stationId: grill.body.id,
  }).expect(201);
  const burger = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Burger',
    variants: [{ name: 'Standart', price: 40000 }],
  }).expect(201);
  const lavash = await post(owner, '/menu/products', {
    categoryId: category.body.id,
    name: 'Lavash',
    variants: [{ name: 'Standart', price: 30000 }],
  }).expect(201);
  const variants = await ctx.db.productVariant.findMany({
    where: { tenantId, productId: { in: [burger.body.id, lavash.body.id] } },
  });
  const burgerVariant = variants.find((v) => v.productId === burger.body.id)!;
  const lavashVariant = variants.find((v) => v.productId === lavash.body.id)!;
  await addUser(ctx, tenantId, {
    username: 'ofitsiant',
    roleIds: [tenant.roleId('waiter')],
  });
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  const printer = await ctx.db.printer.create({
    data: {
      tenantId,
      branchId: tenant.branch.id,
      name: 'Grill printer',
      kind: 'KITCHEN',
      stationId: grill.body.id,
      host: '127.0.0.1',
      port: 1,
    },
  });
  return { tenant, owner, waiter, burgerVariant, lavashVariant, printer };
}

const ticketsOf = async (orderId: string) =>
  (
    await ctx.db.printJob.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    })
  ).map((job) => ({
    purpose: job.purpose,
    text: Buffer.from(job.payload).toString('latin1'),
  }));

describe('order routing and kitchen tickets', () => {
  it('prints delivery banner and waiter, then an update ticket for changes', async () => {
    const s = await setup();
    const order = await post(s.waiter, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DELIVERY',
      customerPhone: '+998901234567',
      deliveryAddress: 'Chilonzor 1',
      place: true,
      items: [
        { variantId: s.burgerVariant.id, quantity: 2 },
        { variantId: s.lavashVariant.id, quantity: 1 },
      ],
    }).expect(201);
    expect(order.body.status).toBe('PLACED');
    await enqueueKitchenTickets(ctx.services, order.body.id);
    let tickets = await ticketsOf(order.body.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.purpose).toBe('NEW');
    expect(tickets[0]!.text).toContain('! DOSTAVKA !');
    expect(tickets[0]!.text).toContain('Ofitsiant:');
    expect(tickets[0]!.text).toContain('2 x Burger');
    // Customer address is not printed on kitchen tickets.
    expect(tickets[0]!.text).not.toContain('Chilonzor');
    expect(tickets[0]!.text).not.toContain('40 000');

    const lavashItem = order.body.items.find(
      (item: { productName: string }) => item.productName === 'Lavash',
    );
    await post(
      s.owner,
      `/orders/${order.body.id}/items/${lavashItem.id}/cancel`,
      {
        reason: 'Mijoz rad etdi',
      },
    ).expect(200);
    await post(s.owner, `/orders/${order.body.id}/items`, {
      items: [{ variantId: s.burgerVariant.id, quantity: 1, note: 'Achchiq' }],
    }).expect(200);
    await enqueueKitchenTickets(ctx.services, order.body.id);
    await enqueueKitchenTickets(ctx.services, order.body.id); // idempotent
    tickets = await ticketsOf(order.body.id);
    expect(tickets).toHaveLength(2);
    const update = tickets[1]!;
    expect(update.purpose).toBe('UPDATE');
    expect(update.text).toContain('DIQQAT! CHEK YANGILANDI');
    expect(update.text).toContain('Versiya');
    expect(update.text).toContain('--1-x-Lavash-- BEKOR');
    expect(update.text).toContain('1 x Burger');
    expect(update.text).toContain('! Achchiq');
    expect(update.text).not.toContain('2 x Burger');
  });

  it('holds waiter orders for cashier confirmation when required', async () => {
    const s = await setup();
    const settings = await put(s.owner, '/settings/orders', {
      requireCashierConfirm: true,
      kitchenPrices: true,
    }).expect(200);
    expect(settings.body.settings.requireCashierConfirm).toBe(true);
    const order = await post(s.waiter, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: s.burgerVariant.id, quantity: 1 }],
    }).expect(201);
    expect(order.body.status).toBe('PENDING');
    await enqueueKitchenTickets(ctx.services, order.body.id);
    expect(await ticketsOf(order.body.id)).toHaveLength(0);
    // The waiter cannot approve their own order; the cashier/owner can.
    await post(s.waiter, `/orders/${order.body.id}/approve`).expect(403);
    await post(s.owner, `/orders/${order.body.id}/approve`).expect(200);
    const approved = await ctx.db.order.findUniqueOrThrow({
      where: { id: order.body.id },
    });
    expect(approved.status).toBe('PLACED');
    expect(approved.createdById).not.toBeNull();
    await enqueueKitchenTickets(ctx.services, order.body.id);
    const tickets = await ticketsOf(order.body.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.text).toContain('40 000');
    // Owners take payments, so their orders go straight to the kitchen.
    const direct = await post(s.owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: s.burgerVariant.id, quantity: 1 }],
    }).expect(201);
    expect(direct.body.status).toBe('PLACED');
  });

  it('copies failing tickets once to the fallback printer', async () => {
    const s = await setup();
    const received: Buffer[] = [];
    const tcp = createTcpServer((socket) =>
      socket.on('data', (chunk) => received.push(chunk)),
    );
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const port = (tcp.address() as AddressInfo).port;
    const backup = await ctx.db.printer.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        name: 'Zaxira',
        kind: 'RECEIPT',
        host: '127.0.0.1',
        port,
      },
    });
    await ctx.db.printer.update({
      where: { id: s.printer.id },
      data: { fallbackPrinterId: backup.id },
    });
    const order = await post(s.owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: s.burgerVariant.id, quantity: 3 }],
    }).expect(201);
    await enqueueKitchenTickets(ctx.services, order.body.id);
    const job = await ctx.db.printJob.findFirstOrThrow({
      where: { orderId: order.body.id },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await ctx.db.printJob.updateMany({
        where: { orderId: order.body.id, status: 'PENDING' },
        data: { nextTryAt: new Date(0) },
      });
      await processPrintJobs(ctx.services);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const copies = await ctx.db.printJob.findMany({
      where: { fallbackFromId: job.id },
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]!.status).toBe('SENT');
    expect(Buffer.concat(received).toString('latin1')).toContain('3 x Burger');
    tcp.close();
  });
});
