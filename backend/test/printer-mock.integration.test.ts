import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoPrintOrder } from '../src/printing/auto.js';
import {
  enqueueKitchenTickets,
  processPrintJobs,
} from '../src/printing/queue.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Printers simulated by real TCP listeners (raw port 9100 protocol): what the server
// actually sends over the network under the printing rules, and the fallback printer.

const ctx = createTestContext();
ctx.services.afterOrderChange = async (orderId) => {
  await enqueueKitchenTickets(ctx.services, orderId);
  await autoPrintOrder(ctx.services, orderId);
};
type Mock = { port: number; received: () => string; server: Server };
const mocks: Mock[] = [];
async function mockPrinter(): Promise<Mock> {
  const chunks: Buffer[] = [];
  const server = createServer((socket) =>
    socket.on('data', (chunk) => chunks.push(chunk)),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const mock = {
    port: (server.address() as AddressInfo).port,
    received: () => Buffer.concat(chunks).toString('latin1'),
    server,
  };
  mocks.push(mock);
  return mock;
}
// A port nobody listens on (connection refused at once).
async function deadPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
let tenantId = '';
beforeAll(async () => {
  // Jobs other test files left for unreachable printers must not hold this queue up.
  await ctx.db.printJob.updateMany({
    where: { status: 'PENDING' },
    data: { nextTryAt: new Date(Date.now() + 365 * 86_400_000) },
  });
});
afterAll(async () => {
  for (const mock of mocks)
    await new Promise((resolve) => mock.server.close(resolve));
  await ctx.db.printJob.updateMany({
    where: { tenantId, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  await ctx.close();
});
const post = (
  agent: ReturnType<typeof ctx.agent>,
  path: string,
  body: object = {},
) => agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
// Runs the queue until the given printers' jobs are no longer pending.
async function drain(printerIds: string[]) {
  for (let i = 0; i < 20; i++) {
    await processPrintJobs(ctx.services);
    const left = await ctx.db.printJob.count({
      where: {
        printerId: { in: printerIds },
        status: { in: ['PENDING', 'PRINTING'] },
        nextTryAt: { lte: new Date() },
      },
    });
    if (left === 0) return;
  }
}
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
};

describe('printing to simulated network printers', () => {
  it('receipt copies, manual kebab tickets and the fallback printer over real sockets', async () => {
    const tenant = await createTenant(ctx);
    tenantId = tenant.tenant.id;
    const branchId = tenant.branch.id;
    const kebabStation = await ctx.db.kitchenStation.create({
      data: { tenantId, name: 'Kabob', printType: 'KEBAB' },
    });
    const kitchenStation = await ctx.db.kitchenStation.create({
      data: { tenantId, name: 'Oshxona' },
    });
    const product = async (name: string, stationId: string, price: number) => {
      const category = await ctx.db.menuCategory.create({
        data: { tenantId, name, stationId },
      });
      const p = await ctx.db.product.create({
        data: { tenantId, categoryId: category.id, name },
      });
      return ctx.db.productVariant.create({
        data: { tenantId, productId: p.id, name: 'Standart', price },
      });
    };
    const shashlik = await product('Shashlik', kebabStation.id, 20_000);
    const osh = await product('Osh', kitchenStation.id, 30_000);
    const receiptMock = await mockPrinter();
    const kebabMock = await mockPrinter();
    const spareMock = await mockPrinter();
    const printer = (
      name: string,
      kind: 'KITCHEN' | 'RECEIPT',
      port: number,
      stationId: string | null,
      fallbackPrinterId?: string,
    ) =>
      ctx.db.printer.create({
        data: {
          tenantId,
          branchId,
          name,
          kind,
          host: '127.0.0.1',
          port,
          stationId,
          ...(fallbackPrinterId ? { fallbackPrinterId } : {}),
        },
      });
    const receipt = await printer('Kassa', 'RECEIPT', receiptMock.port, null);
    const kebab = await printer(
      'Kabob',
      'KITCHEN',
      kebabMock.port,
      kebabStation.id,
    );
    // A department's spare printer (a printer without a department would get every item).
    const spare = await printer(
      'Zaxira oshxona',
      'KITCHEN',
      spareMock.port,
      kitchenStation.id,
    );
    // The kitchen printer is off: after two failed tries its tickets go to the spare one.
    const kitchen = await printer(
      'Oshxona (o‘chiq)',
      'KITCHEN',
      await deadPort(),
      kitchenStation.id,
      spare.id,
    );
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await owner
      .put('/api/print-rules')
      .set('Origin', ORIGIN)
      .send({
        rules: {
          PAID: { copies: 2, trigger: 'AUTO', printerId: receipt.id },
          KEBAB: { trigger: 'MANUAL' },
        },
      })
      .expect(200);
    await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [
        { variantId: shashlik.id, quantity: 2 },
        { variantId: osh.id, quantity: 1 },
      ],
    }).expect(201);
    await post(owner, `/orders/${order.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: order.body.total,
      tendered: order.body.total,
    }).expect(201);
    await drain([receipt.id, kebab.id]);

    // Paid receipt: two copies arrived on the receipt printer, the job is SENT.
    await waitFor(() => receiptMock.received().split('JAMI').length - 1 >= 2);
    expect(receiptMock.received().split('JAMI').length - 1).toBe(2);
    const receiptJob = await ctx.db.printJob.findFirstOrThrow({
      where: { printerId: receipt.id },
    });
    expect(receiptJob.status).toBe('SENT');
    // Kebab rule MANUAL: nothing yet.
    expect(kebabMock.received()).toBe('');
    await post(owner, `/orders/${order.body.id}/kitchen-print`).expect(200);
    await drain([kebab.id]);
    await waitFor(() => kebabMock.received().includes('Shashlik'));
    expect(kebabMock.received()).toContain('2 x Shashlik');
    expect(kebabMock.received()).not.toContain('Osh');

    // The dead kitchen printer: two failed tries, then a copy on the spare printer.
    for (let attempt = 0; attempt < 2; attempt++) {
      await ctx.db.printJob.updateMany({
        where: { printerId: kitchen.id, status: 'PENDING' },
        data: { nextTryAt: new Date(Date.now() - 1000) },
      });
      await processPrintJobs(ctx.services);
    }
    const failedJob = await ctx.db.printJob.findFirstOrThrow({
      where: { printerId: kitchen.id },
    });
    // (The queue already tried once while the receipt went out.)
    expect(failedJob.attempts).toBeGreaterThanOrEqual(2);
    expect(failedJob.lastError).toBeTruthy();
    await drain([spare.id]);
    await waitFor(() => spareMock.received().includes('Osh'));
    expect(spareMock.received()).toContain('1 x Osh');
    const copy = await ctx.db.printJob.findFirstOrThrow({
      where: { printerId: spare.id },
    });
    expect(copy).toMatchObject({
      fallbackFromId: failedJob.id,
      status: 'SENT',
    });
  }, 60_000);
});
