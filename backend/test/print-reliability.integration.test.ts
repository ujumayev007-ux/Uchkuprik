import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueKitchenTickets, processPrintJobs } from '../src/printing/queue.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Print queue: a job that may already be on paper is never resent by itself, and a
// manual resend asks first and keeps the history. Printing rules per receipt type.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const category = await ctx.db.menuCategory.create({ data: { tenantId, name: 'Taomlar' } });
  const product = await ctx.db.product.create({ data: { tenantId, categoryId: category.id, name: 'Burger' } });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Standart', price: 30_000 },
  });
  // A printer nobody listens on (jobs stay in the queue).
  const printer = await ctx.db.printer.create({
    data: { tenantId, branchId: tenant.branch.id, name: 'Oshxona', kind: 'KITCHEN', host: '127.0.0.1', port: 1 },
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const placeOrder = async () =>
    (
      await post(owner, '/orders', {
        idempotencyKey: randomUUID(),
        type: 'TAKEAWAY',
        place: true,
        items: [{ variantId: variant.id, quantity: 2 }],
      }).expect(201)
    ).body.id as string;
  return { tenantId, printer, owner, placeOrder };
}

describe('print queue reliability', () => {
  it('an interrupted send becomes UNKNOWN; a resend needs confirmation and keeps history', async () => {
    const s = await setup();
    const job = await ctx.db.printJob.create({
      data: {
        tenantId: s.tenantId,
        printerId: s.printer.id,
        kind: 'KITCHEN',
        payload: Buffer.from('ticket'),
        status: 'PRINTING',
        nextTryAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await processPrintJobs(ctx.services);
    const after = await ctx.db.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('UNKNOWN');
    // Not resent by itself.
    await processPrintJobs(ctx.services);
    expect((await ctx.db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('UNKNOWN');
    const refused = await post(s.owner, `/print-jobs/${job.id}/retry`).expect(409);
    expect(refused.body.code).toBe('PRINT_MAY_DUPLICATE');
    const reprint = await post(s.owner, `/print-jobs/${job.id}/retry`, { confirmDuplicate: true }).expect(200);
    const copy = await ctx.db.printJob.findUniqueOrThrow({ where: { id: reprint.body.id } });
    expect(copy).toMatchObject({ status: 'PENDING', purpose: 'REPRINT', reprintOfId: job.id });
    expect((await ctx.db.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('UNKNOWN');
    const audit = await ctx.db.auditLog.findFirst({ where: { tenantId: s.tenantId, action: 'print.reprint' } });
    expect(audit).not.toBeNull();
  });
});

describe('printing rules', () => {
  it('without rules nothing changes; copies, prices and switched-off kitchen tickets follow the rules', async () => {
    const s = await setup();
    const plain = await s.placeOrder();
    await enqueueKitchenTickets(ctx.services, plain);
    const first = await ctx.db.printJob.findFirstOrThrow({ where: { orderId: plain } });
    const single = Buffer.from(first.payload).toString('latin1');
    expect(single).toContain('2 x Burger');

    const rules = await post(s.owner, '/print-rules', {});
    expect([404, 405]).toContain(rules.status); // PUT only
    await s.owner
      .put('/api/print-rules')
      .set('Origin', ORIGIN)
      .send({ rules: { KITCHEN: { enabled: true, copies: 2, trigger: 'AUTO', showPrices: true } } })
      .expect(200);
    const doubled = await s.placeOrder();
    await enqueueKitchenTickets(ctx.services, doubled);
    const job = await ctx.db.printJob.findFirstOrThrow({ where: { orderId: doubled } });
    const text = Buffer.from(job.payload).toString('latin1');
    expect(text.split('2 x Burger').length - 1).toBe(2);
    expect(text).toMatch(/60[ ,.]?000/);

    await s.owner
      .put('/api/print-rules')
      .set('Origin', ORIGIN)
      .send({ rules: { KITCHEN: { enabled: false, copies: 1, trigger: 'AUTO', showPrices: false } } })
      .expect(200);
    const off = await s.placeOrder();
    await enqueueKitchenTickets(ctx.services, off);
    expect(await ctx.db.printJob.count({ where: { orderId: off } })).toBe(0);
    // Marked as handled: switching back on does not print old tickets.
    expect(await ctx.db.orderItem.count({ where: { orderId: off, kitchenPrintedAt: null } })).toBe(0);
  });
});
