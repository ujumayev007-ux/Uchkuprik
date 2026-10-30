import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PRESETS } from '../src/modules/workflow/engine.js';
import { storeWorkflow } from '../src/modules/workflow/restaurant.js';
import { autoPrintOrder, printShiftReport } from '../src/printing/auto.js';
import { enqueueKitchenTickets } from '../src/printing/queue.js';
import { RECEIPT_TYPES } from '../src/printing/rules.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// All 12 printing rules (Chop etish qoidalari): kitchen / kebab / bar tickets per
// department, manual and after-payment triggers, receipts the server prints by itself
// (paid, credit, preliminary bill, delivery slip, refund, shift report) and the plan
// the screens print by (on/off, copies).

const ctx = createTestContext();
// As the server wires it: kitchen tickets, then rule-bound receipts.
ctx.services.afterOrderChange = async (orderId) => {
  await enqueueKitchenTickets(ctx.services, orderId);
  await autoPrintOrder(ctx.services, orderId);
};
// Jobs for printers nobody listens on must not hold up other tests' print queue.
const tenants: string[] = [];
afterAll(async () => {
  await ctx.db.printJob.updateMany({
    where: { tenantId: { in: tenants }, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  await ctx.close();
});
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);
const text = (payload: Uint8Array) => Buffer.from(payload).toString('latin1');

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  tenants.push(tenantId);
  const branchId = tenant.branch.id;
  const kitchen = await ctx.db.kitchenStation.create({
    data: { tenantId, name: 'Oshxona' },
  });
  const kebab = await ctx.db.kitchenStation.create({
    data: { tenantId, name: 'Kabob', printType: 'KEBAB' },
  });
  const bar = await ctx.db.kitchenStation.create({
    data: { tenantId, name: 'Bar', printType: 'BAR' },
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
  const osh = await product('Osh', kitchen.id, 30_000);
  const shashlik = await product('Shashlik', kebab.id, 20_000);
  const choy = await product('Choy', bar.id, 5_000);
  // Printers nobody listens on: jobs stay in the queue to be inspected.
  const printer = (
    name: string,
    kind: 'KITCHEN' | 'RECEIPT',
    stationId: string | null,
  ) =>
    ctx.db.printer.create({
      data: {
        tenantId,
        branchId,
        name,
        kind,
        host: '127.0.0.1',
        port: 1,
        stationId,
      },
    });
  const printers = {
    kitchen: await printer('Oshxona printeri', 'KITCHEN', kitchen.id),
    kebab: await printer('Kabob printeri', 'KITCHEN', kebab.id),
    bar: await printer('Bar printeri', 'KITCHEN', bar.id),
    receipt: await printer('Kassa printeri', 'RECEIPT', null),
  };
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
  const create = async (extra: object = {}) =>
    (
      await post(owner, '/orders', {
        idempotencyKey: randomUUID(),
        type: 'TAKEAWAY',
        place: true,
        items: [
          { variantId: osh.id, quantity: 1 },
          { variantId: shashlik.id, quantity: 2 },
          { variantId: choy.id, quantity: 1 },
        ],
        ...extra,
      }).expect(201)
    ).body as { id: string; total: number };
  const pay = (id: string, amount: number, extra: object = {}) =>
    post(owner, `/orders/${id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount,
      tendered: amount,
      ...extra,
    });
  const rules = (value: object) =>
    put(owner, '/print-rules', { rules: value }).expect(200);
  const jobs = (orderId: string) =>
    ctx.db.printJob.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  return { tenantId, branchId, owner, printers, create, pay, rules, jobs, osh };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const onPrinter = (
  all: Awaited<ReturnType<Setup['jobs']>>,
  printerId: string,
) => all.filter((job) => job.printerId === printerId);

describe('kitchen, kebab and bar tickets', () => {
  it('each department follows its own rule; Kabob / Bar without a rule follow the kitchen', async () => {
    const s = await setup();
    await s.rules({
      KITCHEN: { copies: 1 },
      KEBAB: { copies: 2, showPrices: true },
      BAR: { enabled: false },
    });
    const order = await s.create();
    await enqueueKitchenTickets(ctx.services, order.id);
    const all = await s.jobs(order.id);
    expect(onPrinter(all, s.printers.kitchen.id)).toHaveLength(1);
    const kebab = text(onPrinter(all, s.printers.kebab.id)[0]!.payload);
    expect(kebab.split('2 x Shashlik').length - 1).toBe(2);
    expect(kebab).toMatch(/40[ ,.]?000/);
    // Bar switched off: nothing printed, the item counts as handled.
    expect(onPrinter(all, s.printers.bar.id)).toHaveLength(0);
    expect(
      await ctx.db.orderItem.count({
        where: { orderId: order.id, kitchenPrintedAt: null },
      }),
    ).toBe(0);

    // Only a kitchen rule: Kabob follows it (two copies there too).
    await s.rules({ KITCHEN: { copies: 2 } });
    const second = await s.create();
    await enqueueKitchenTickets(ctx.services, second.id);
    const kebabJob = onPrinter(
      await s.jobs(second.id),
      s.printers.kebab.id,
    )[0]!;
    expect(text(kebabJob.payload).split('2 x Shashlik').length - 1).toBe(2);
  });

  it('MANUAL waits for «Oshxonaga chop etish»; AFTER_PAYMENT waits for the payment', async () => {
    const s = await setup();
    await s.rules({
      KEBAB: { trigger: 'MANUAL' },
      BAR: { trigger: 'AFTER_PAYMENT' },
    });
    const order = await s.create();
    await enqueueKitchenTickets(ctx.services, order.id);
    let all = await s.jobs(order.id);
    expect(onPrinter(all, s.printers.kitchen.id)).toHaveLength(1);
    expect(onPrinter(all, s.printers.kebab.id)).toHaveLength(0);
    expect(onPrinter(all, s.printers.bar.id)).toHaveLength(0);
    // Waiting items stay unprinted.
    expect(
      await ctx.db.orderItem.count({
        where: { orderId: order.id, kitchenPrintedAt: null },
      }),
    ).toBe(2);

    // Paid: the bar ticket goes out by itself; the kebab one still waits.
    await s.pay(order.id, order.total).expect(201);
    all = await s.jobs(order.id);
    expect(onPrinter(all, s.printers.bar.id).length).toBe(1);
    expect(onPrinter(all, s.printers.kebab.id)).toHaveLength(0);

    // Staff print it by hand.
    const manual = await post(
      s.owner,
      `/orders/${order.id}/kitchen-print`,
    ).expect(200);
    expect(manual.body.jobs).toBe(1);
    all = await s.jobs(order.id);
    expect(onPrinter(all, s.printers.kebab.id)).toHaveLength(1);
    expect(
      await ctx.db.orderItem.count({
        where: { orderId: order.id, kitchenPrintedAt: null },
      }),
    ).toBe(0);
    // Nothing left: a second press prints nothing.
    expect(
      (await post(s.owner, `/orders/${order.id}/kitchen-print`).expect(200))
        .body.jobs,
    ).toBe(0);
    const audit = await ctx.db.auditLog.count({
      where: { tenantId: s.tenantId, action: 'order.kitchen_print' },
    });
    expect(audit).toBe(2);
  });
});

describe('receipts the server prints by itself', () => {
  it('paid receipt once after full payment, with the rule copies, only on the named printer', async () => {
    const s = await setup();
    await s.rules({
      PAID: { trigger: 'AUTO', copies: 2, printerId: s.printers.receipt.id },
    });
    const order = await s.create();
    await s.pay(order.id, 10_000).expect(201);
    expect(
      onPrinter(await s.jobs(order.id), s.printers.receipt.id),
    ).toHaveLength(0);
    await s.pay(order.id, order.total - 10_000).expect(201);
    // Changed again later: still one receipt.
    await autoPrintOrder(ctx.services, order.id);
    const receipts = onPrinter(await s.jobs(order.id), s.printers.receipt.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.purpose).toBe('AUTO_PAID');
    expect(text(receipts[0]!.payload).split('JAMI').length - 1).toBe(2);

    // MANUAL: never by itself.
    await s.rules({
      PAID: { trigger: 'MANUAL', printerId: s.printers.receipt.id },
    });
    const manual = await s.create();
    await s.pay(manual.id, manual.total).expect(201);
    expect(
      onPrinter(await s.jobs(manual.id), s.printers.receipt.id),
    ).toHaveLength(0);
  });

  it('preliminary bill when placed; delivery slip; credit receipt with the signature line', async () => {
    const s = await setup();
    await s.rules({
      PRELIM_BILL: {
        trigger: 'AFTER_APPROVAL',
        printerId: s.printers.receipt.id,
      },
      DELIVERY: { trigger: 'AUTO', printerId: s.printers.receipt.id },
      CREDIT: { trigger: 'AFTER_PAYMENT', printerId: s.printers.receipt.id },
    });
    const dineIn = await s.create({
      type: 'DELIVERY',
      customerPhone: '+998901112233',
      deliveryAddress: 'Chilonzor 5-uy',
    });
    await autoPrintOrder(ctx.services, dineIn.id);
    const purposes = onPrinter(
      await s.jobs(dineIn.id),
      s.printers.receipt.id,
    ).map((j) => j.purpose);
    expect(purposes.sort()).toEqual(['AUTO_BILL', 'AUTO_DELIVERY']);
    const slip = onPrinter(await s.jobs(dineIn.id), s.printers.receipt.id).find(
      (j) => j.purpose === 'AUTO_DELIVERY',
    )!;
    expect(text(slip.payload)).toContain('Chilonzor 5-uy');

    // Credit (nasiya) under workflow 17.
    await storeWorkflow(ctx.db, s.tenantId, {
      version: 1,
      config: PRESETS.find((p) => p.id === 17)!.config(),
    });
    const account = await post(s.owner, '/credit-accounts', {
      kind: 'CUSTOMER',
      name: 'Aziz aka',
    }).expect(201);
    const credit = await s.create({ type: 'TAKEAWAY', place: false });
    await s
      .pay(credit.id, credit.total, {
        method: 'CREDIT',
        creditAccountId: account.body.account.id,
        tendered: undefined,
      })
      .expect(201);
    const creditJobs = onPrinter(
      await s.jobs(credit.id),
      s.printers.receipt.id,
    );
    expect(creditJobs.map((j) => j.purpose)).toEqual(['AUTO_PAID']);
    const creditText = text(creditJobs[0]!.payload);
    expect(creditText).toContain('QARZGA YOZILDI');
    expect(creditText).toContain('Aziz aka');
    expect(creditText).toContain('Mijoz imzosi');
  });

  it('refund slip and shift report on their printers; rules may name only own printers', async () => {
    const s = await setup();
    await s.rules({
      REFUND: { trigger: 'AUTO', printerId: s.printers.receipt.id },
      SHIFT_REPORT: { trigger: 'AUTO', printerId: s.printers.receipt.id },
    });
    const order = await s.create();
    const paid = await s.pay(order.id, order.total).expect(201);
    await post(s.owner, `/orders/${order.id}/refunds`, {
      paymentId: paid.body.paymentId,
      amount: 5_000,
      reason: 'Choy qaytdi',
    }).expect(201);
    const refundJobs = (await s.jobs(order.id)).filter((j) =>
      j.purpose.startsWith('REFUND:'),
    );
    expect(refundJobs).toHaveLength(1);
    expect(text(refundJobs[0]!.payload)).toContain('QAYTARISH');
    // Printed again by hand: marked as a copy.
    const refundId = refundJobs[0]!.purpose.slice('REFUND:'.length);
    await post(s.owner, `/orders/${order.id}/refunds/${refundId}/print`, {
      printerId: s.printers.receipt.id,
    }).expect(201);
    const again = (await s.jobs(order.id)).filter((j) =>
      j.purpose.startsWith('REFUND:'),
    );
    expect(again).toHaveLength(2);
    expect(text(again[1]!.payload)).toContain('NUSXA');

    const shift = await ctx.db.cashShift.findFirstOrThrow({
      where: { tenantId: s.tenantId, status: 'OPEN' },
    });
    await post(s.owner, `/shifts/${shift.id}/close`, {
      countedCash: order.total - 5_000,
    }).expect(200);
    const reports = await ctx.db.printJob.findMany({
      where: { tenantId: s.tenantId, purpose: `SHIFT:${shift.id}` },
    });
    expect(reports).toHaveLength(1);
    expect(text(reports[0]!.payload)).toContain('Z-HISOBOT');
    // Once only.
    expect(await printShiftReport(ctx.services, shift.id)).toBeNull();

    const other = await createTenant(ctx);
    const foreign = await ctx.db.printer.create({
      data: {
        tenantId: other.tenant.id,
        branchId: other.branch.id,
        name: 'Begona',
        kind: 'RECEIPT',
        host: '127.0.0.1',
        port: 1,
      },
    });
    await put(s.owner, '/print-rules', {
      rules: { PAID: { printerId: foreign.id } },
    }).expect(400);
  });
});

describe('what the screens print by', () => {
  it('the receipt and the shift report carry their rule; a switched-off type is refused', async () => {
    const s = await setup();
    const all = await s.owner.get('/api/print-rules').expect(200);
    expect(all.body.enforced).toEqual([...RECEIPT_TYPES]);
    await s.rules({ SALES: { copies: 3 }, PAID: { enabled: false } });
    const order = await s.create();
    const bill = await s.owner
      .get(`/api/orders/${order.id}/receipt`)
      .expect(200);
    expect(bill.body.printRule).toMatchObject({
      type: 'PRELIM_BILL',
      enabled: true,
      copies: 3,
    });
    await s.pay(order.id, order.total).expect(201);
    const paid = await s.owner
      .get(`/api/orders/${order.id}/receipt`)
      .expect(200);
    expect(paid.body.printRule).toMatchObject({ type: 'PAID', enabled: false });
    const refused = await post(s.owner, `/orders/${order.id}/receipt/print`, {
      printerId: s.printers.receipt.id,
    }).expect(409);
    expect(refused.body.code).toBe('PRINT_RULE_OFF');
    const shift = await ctx.db.cashShift.findFirstOrThrow({
      where: { tenantId: s.tenantId, status: 'OPEN' },
    });
    await s.rules({ SHIFT_REPORT: { copies: 2 } });
    const report = await s.owner
      .get(`/api/shifts/${shift.id}/report`)
      .expect(200);
    expect(report.body.printRule).toMatchObject({
      type: 'SHIFT_REPORT',
      enabled: true,
      copies: 2,
    });
  });
});
