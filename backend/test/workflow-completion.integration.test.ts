import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import {
  PRESETS,
  validateWorkflow,
  type WorkflowConfig,
} from '../src/modules/workflow/engine.js';
import { storeWorkflow } from '../src/modules/workflow/restaurant.js';
import { releaseDueOrders } from '../src/modules/workflow/schedule.js';
import { createEventBus } from '../src/realtime/bus.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
} from './helpers.js';

// Workflows 11 (scheduled orders), 12 (banquets), 17 (customer credit) and 18 (hotel
// room bills) on the restaurant server.

const ctx = createTestContext();
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
ctx.services.events = createEventBus();
afterAll(() => ctx.close());
afterEach(() => {
  ctx.clock.offsetMs = 0;
});
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

let version = 0;
async function setup(config: WorkflowConfig | null) {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Osh' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Oddiy', price: 40_000 },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: branch.id, name: 'Zal', kind: 'HALL' },
  });
  const table = await ctx.db.diningTable.create({
    data: {
      tenantId,
      branchId: branch.id,
      roomId: room.id,
      name: '1-stol',
      qrToken: `qr${randomUUID().replace(/-/g, '')}`,
    },
  });
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
    data: { customerId: customer.id, features: {} },
  });
  if (config)
    await storeWorkflow(ctx.db, tenantId, { version: ++version, config });
  clearPolicyCache();
  clearAdminSettingsCache();
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  await post(cashier, '/shifts/open', { openingCash: 0 }).expect(201);
  return { tenantId, branch, variant, table, owner, cashier, waiter };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const order = (s: Setup, extra: object = {}) => ({
  idempotencyKey: randomUUID(),
  type: 'DINE_IN',
  items: [{ variantId: s.variant.id, quantity: 1 }],
  ...extra,
});
const pay = (s: Setup, id: string, amount: number, extra: object = {}) =>
  post(s.cashier, `/orders/${id}/payments`, {
    idempotencyKey: randomUUID(),
    method: 'CASH',
    amount,
    tendered: amount,
    ...extra,
  });
const credit = (s: Setup, id: string, amount: number, accountId: string) =>
  post(s.cashier, `/orders/${id}/payments`, {
    idempotencyKey: randomUUID(),
    method: 'CREDIT',
    amount,
    creditAccountId: accountId,
  });
const preset = (id: number) => PRESETS.find((p) => p.id === id)!.config();
const inHours = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

describe('customer credit (nasiya, workflow 17)', () => {
  it('charges within the limit, takes repayments into the cash drawer and closes settled accounts', async () => {
    const s = await setup(preset(17));
    const account = await post(s.owner, '/credit-accounts', {
      kind: 'CUSTOMER',
      name: 'Aziz aka',
      phone: '+998901234567',
      creditLimit: 50_000,
    }).expect(201);
    const accountId = account.body.account.id as string;
    // The cashier sees accounts but may not open them.
    await post(s.cashier, '/credit-accounts', {
      kind: 'CUSTOMER',
      name: 'X',
    }).expect(403);

    const first = await post(
      s.waiter,
      '/orders',
      order(s, { tableId: s.table.id, place: true }),
    ).expect(201);
    expect(first.body.workflow).toMatchObject({ payment: 'CREDIT' });
    await credit(s, first.body.id, 40_000, accountId).expect(201);
    const paid = await ctx.db.order.findUniqueOrThrow({
      where: { id: first.body.id },
    });
    expect(paid.paidTotal).toBe(40_000);
    expect(
      (
        await ctx.db.creditAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).balance,
    ).toBe(40_000);

    // Over the limit.
    const second = await post(
      s.cashier,
      '/orders',
      order(s, { type: 'TAKEAWAY' }),
    ).expect(201);
    const over = await credit(s, second.body.id, 40_000, accountId).expect(409);
    expect(over.body.code).toBe('CREDIT_LIMIT');

    // Not settled: cannot close. Cash repayment goes into the drawer as a pay-in.
    expect(
      (await post(s.owner, `/credit-accounts/${accountId}/close`).expect(409))
        .body.code,
    ).toBe('CREDIT_NOT_SETTLED');
    const key = randomUUID();
    await post(s.cashier, `/credit-accounts/${accountId}/repayments`, {
      idempotencyKey: key,
      method: 'CASH',
      amount: 30_000,
    }).expect(201);
    // Retried: no second repayment.
    await post(s.cashier, `/credit-accounts/${accountId}/repayments`, {
      idempotencyKey: key,
      method: 'CASH',
      amount: 30_000,
    }).expect(200);
    const movements = await ctx.db.cashMovement.findMany({
      where: { tenantId: s.tenantId },
    });
    expect(movements.map((m) => m.amount)).toEqual([30_000]);
    await post(s.cashier, `/credit-accounts/${accountId}/repayments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 20_000,
    }).expect(409);
    await post(s.cashier, `/credit-accounts/${accountId}/repayments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 10_000,
    }).expect(201);
    await post(s.owner, `/credit-accounts/${accountId}/close`).expect(200);
    const closed = await credit(s, second.body.id, 10_000, accountId).expect(
      409,
    );
    expect(closed.body.code).toBe('CREDIT_ACCOUNT_CLOSED');

    const detail = await s.cashier
      .get(`/api/credit-accounts/${accountId}`)
      .expect(200);
    expect(
      detail.body.account.entries.map((e: { type: string }) => e.type),
    ).toEqual(['REPAYMENT', 'REPAYMENT', 'CHARGE']);
    expect(detail.body.orders.map((o: { id: string }) => o.id)).toEqual([
      first.body.id,
    ]);
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, action: { startsWith: 'credit.' } },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      'credit.account.close',
      'credit.account.create',
      'credit.repayment',
      'credit.repayment',
    ]);
  });

  it('a refunded credit charge lowers the debt; without the workflow credit is refused', async () => {
    const s = await setup(preset(17));
    const account = await post(s.owner, '/credit-accounts', {
      kind: 'CUSTOMER',
      name: 'Bekzod',
    }).expect(201);
    const accountId = account.body.account.id as string;
    const draft = await post(
      s.cashier,
      '/orders',
      order(s, { type: 'TAKEAWAY' }),
    ).expect(201);
    const charged = await credit(s, draft.body.id, 40_000, accountId).expect(
      201,
    );
    await post(s.owner, `/orders/${draft.body.id}/refunds`, {
      paymentId: charged.body.paymentId,
      amount: 15_000,
      reason: 'Bitta taom qaytdi',
    }).expect(201);
    expect(
      (
        await ctx.db.creditAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).balance,
    ).toBe(25_000);

    const plain = await setup(null);
    const other = await post(plain.owner, '/credit-accounts', {
      kind: 'CUSTOMER',
      name: 'Ali',
    }).expect(201);
    const loose = await post(
      plain.cashier,
      '/orders',
      order(plain, { type: 'TAKEAWAY' }),
    ).expect(201);
    const refused = await credit(
      plain,
      loose.body.id,
      40_000,
      other.body.account.id,
    ).expect(409);
    expect(refused.body.code).toBe('CREDIT_NOT_ALLOWED');
    // Another restaurant's account is never reachable.
    await plain.cashier.get(`/api/credit-accounts/${accountId}`).expect(404);
  });
});

describe('hotel room bills (workflow 18)', () => {
  it('charges orders to a room and checks the guest out after settling', async () => {
    const s = await setup(preset(18));
    await post(s.owner, '/credit-accounts', {
      kind: 'HOTEL_ROOM',
      name: 'Ivanov',
    }).expect(400);
    const room = await post(s.owner, '/credit-accounts', {
      kind: 'HOTEL_ROOM',
      name: 'Ivanov',
      room: '305',
      checkoutAt: inHours(48),
    }).expect(201);
    const accountId = room.body.account.id as string;
    const placed = await post(
      s.waiter,
      '/orders',
      order(s, { tableId: s.table.id, place: true }),
    ).expect(201);
    await credit(s, placed.body.id, 40_000, accountId).expect(201);
    const list = await s.cashier
      .get('/api/credit-accounts?open=true&kind=HOTEL_ROOM&q=305')
      .expect(200);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0]).toMatchObject({
      label: 'Xona 305 — Ivanov',
      balance: 40_000,
    });
    await post(s.cashier, `/credit-accounts/${accountId}/repayments`, {
      idempotencyKey: randomUUID(),
      method: 'CARD',
      amount: 40_000,
    }).expect(201);
    await post(s.owner, `/credit-accounts/${accountId}/close`).expect(200);
  });
});

describe('scheduled orders (workflow 11)', () => {
  it('waits until its time, then reaches the kitchen; refused without the workflow', async () => {
    const s = await setup(preset(11));
    const at = inHours(3);
    const draft = await post(
      s.cashier,
      '/orders',
      order(s, { type: 'TAKEAWAY', scheduledFor: at }),
    ).expect(201);
    const id = draft.body.id as string;
    expect(draft.body.scheduledFor).toBe(at);
    // Advance (30%) paid: confirmed, but it waits for its time.
    await pay(s, id, 12_000).expect(201);
    let row = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.scheduleConfirmedAt).not.toBeNull();
    expect(row.placedAt).toBeNull();
    expect(await releaseDueOrders(ctx.services)).not.toContain(id);
    // The rest can be paid while it waits.
    await pay(s, id, 28_000).expect(201);
    // 25 minutes before its time (lead 30 minutes): released.
    ctx.clock.offsetMs = 3 * 3_600_000 - 25 * 60_000;
    expect(await releaseDueOrders(ctx.services)).toContain(id);
    row = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PLACED');
    expect(row.placedAt).not.toBeNull();
    const events = await ctx.db.orderEvent.findMany({
      where: { orderId: id, type: 'status' },
    });
    expect(events.at(-1)?.data).toMatchObject({
      from: 'PENDING',
      to: 'PLACED',
      source: 'schedule',
    });

    // In the past, or where the zone does not schedule.
    ctx.clock.offsetMs = 0;
    await post(
      s.cashier,
      '/orders',
      order(s, { type: 'TAKEAWAY', scheduledFor: inHours(-1) }),
    ).expect(400);
    const plain = await setup(null);
    const refused = await post(
      plain.cashier,
      '/orders',
      order(plain, { type: 'TAKEAWAY', scheduledFor: at }),
    ).expect(409);
    expect(refused.body.code).toBe('WORKFLOW_SCHEDULE');
  });

  it('the Owner check warns when the restaurant server cannot schedule', () => {
    const issues = validateWorkflow(preset(11), { capabilities: ['workflow'] });
    expect(issues.some((i) => /Rejalashtirilgan/.test(i.text))).toBe(true);
    const ok = validateWorkflow(preset(11), {
      capabilities: ['workflow', 'scheduled', 'credit'],
    });
    expect(ok.some((i) => /Rejalashtirilgan/.test(i.text))).toBe(false);
  });
});

describe('banquets (workflow 12)', () => {
  it('booking with advance, Admin approval, free table until the day, released early by staff', async () => {
    const s = await setup(preset(12));
    const at = inHours(48);
    const booking = await post(
      s.cashier,
      '/orders',
      order(s, {
        tableId: s.table.id,
        scheduledFor: at,
        guests: 40,
        eventName: 'To‘y oqshomi',
      }),
    ).expect(201);
    const id = booking.body.id as string;
    // Advance 30% of 40 000.
    await pay(s, id, 12_000).expect(201);
    let row = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    // Cashier is not an Admin: the booking waits for approval.
    expect(row.status).toBe('PENDING');
    expect(row.scheduleConfirmedAt).toBeNull();
    // The table stays free for today's guests.
    await post(s.waiter, '/orders', order(s, { tableId: s.table.id })).expect(
      201,
    );
    // Waiter cannot approve an Admin-approved booking.
    await post(s.waiter, `/orders/${id}/approve`).expect(403);
    await post(s.owner, `/orders/${id}/approve`).expect(200);
    row = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.scheduleConfirmedAt).not.toBeNull();

    const list = await s.cashier.get('/api/scheduled-orders').expect(200);
    expect(list.body.orders).toEqual([
      expect.objectContaining({
        id,
        confirmed: true,
        guests: 40,
        eventName: 'To‘y oqshomi',
        paid: 12_000,
        leadMinutes: 60,
      }),
    ]);
    // Moving the time: allowed until the kitchen has it.
    await post(s.cashier, `/orders/${id}/schedule`, {
      scheduledFor: inHours(50),
      guests: 45,
    }).expect(200);
    expect(
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).guests,
    ).toBe(45);
    // Staff send it now.
    await post(s.cashier, `/orders/${id}/release`).expect(200);
    row = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PLACED');
    await post(s.cashier, `/orders/${id}/release`).expect(409);
    await post(s.cashier, `/orders/${id}/schedule`, {
      scheduledFor: inHours(60),
    }).expect(409);
    const active = await s.waiter.get('/api/workflow/active').expect(200);
    expect(active.body.zones.HALL).toMatchObject({
      scheduling: true,
      scheduleLeadMinutes: 60,
    });
  });
});
