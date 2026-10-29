import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/modules/control/keys.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import {
  PRESETS,
  TEMPLATES,
  validateWorkflow,
  workflowConfigSchema,
  zoneOf,
  type WorkflowConfig,
} from '../src/modules/workflow/engine.js';
import { storeWorkflow } from '../src/modules/workflow/restaurant.js';
import { createEventBus } from '../src/realtime/bus.js';
import { addUser, createTenant, createTestContext, login, ORIGIN, unique } from './helpers.js';

// The shared workflow engine: presets are valid configurations, and the restaurant
// server enforces sources, approval, payment timing, kitchen, queue TV, edits and
// discounts per zone — without changing anything for restaurants that have no workflow.

const server = generateIdentity();
const ctx = createTestContext({
  control: { plane: true, signingKeyPem: server.privateKeyPem, trustedKeys: [server.publicKey] },
});
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
ctx.services.events = createEventBus();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

let version = 0;
async function setup(config: WorkflowConfig | null, roomKind = 'HALL') {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const category = await ctx.db.menuCategory.create({ data: { tenantId, name: 'Taomlar' } });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Lavash' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Oddiy', price: 40_000 },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: branch.id, name: 'Zal', kind: roomKind },
  });
  const table = await ctx.db.diningTable.create({
    data: { tenantId, branchId: branch.id, roomId: room.id, name: '1-stol', qrToken: `qr${randomUUID().replace(/-/g, '')}` },
  });
  await addUser(ctx, tenantId, { username: 'kassir', roleIds: [tenant.roleId('cashier')] });
  await addUser(ctx, tenantId, { username: 'ofitsiant', roleIds: [tenant.roleId('waiter')] });
  const customer = await ctx.db.controlCustomer.create({ data: { name: unique('Mijoz'), tenantId } });
  await ctx.db.controlPolicy.create({ data: { customerId: customer.id, features: {} } });
  await ctx.db.tenantProfile.upsert({
    where: { tenantId },
    create: { tenantId, publicOrdering: true },
    update: { publicOrdering: true },
  });
  if (config) await storeWorkflow(ctx.db, tenantId, { version: ++version, config });
  clearPolicyCache();
  clearAdminSettingsCache();
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  await post(cashier, '/shifts/open', { openingCash: 0 }).expect(201);
  return { tenantId, variant, table, owner, cashier, waiter };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const order = (s: Setup, extra: object = {}) => ({
  idempotencyKey: randomUUID(),
  type: 'DINE_IN',
  items: [{ variantId: s.variant.id, quantity: 1 }],
  ...extra,
});
const pay = (s: Setup, id: string, amount: number) =>
  post(s.cashier, `/orders/${id}/payments`, {
    idempotencyKey: randomUUID(),
    method: 'CASH',
    amount,
    tendered: amount,
  });
const preset = (id: number) => PRESETS.find((p) => p.id === id)!.config();

describe('workflow presets', () => {
  it('all 20 modes and 8 templates are valid configurations with a route per zone', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const p of PRESETS) {
      const config = workflowConfigSchema.parse(p.config());
      expect(config.preset).toBe(p.id);
      expect(Object.keys(config.zones).length).toBeGreaterThan(0);
    }
    expect(TEMPLATES).toHaveLength(8);
    for (const tpl of TEMPLATES) workflowConfigSchema.parse(tpl.config());
  });

  it('detects conflicts before activation', () => {
    const facts = { capabilities: ['workflow'], staff: { cashier: 1, waiter: 0, kitchen: 1 } };
    const issues = validateWorkflow(preset(4), facts);
    expect(issues.some((i) => i.level === 'error' && /ofitsiant/i.test(i.text))).toBe(true);
    const old = validateWorkflow(preset(2), { capabilities: [] });
    expect(old.some((i) => /eski versiya/.test(i.text))).toBe(true);
  });

  it('maps orders to zones', () => {
    expect(zoneOf({ type: 'DINE_IN', channel: 'QR', waiter: false })).toBe('QR');
    expect(zoneOf({ type: 'DINE_IN', channel: 'POS', roomKind: 'VIP', waiter: true })).toBe('VIP');
    expect(zoneOf({ type: 'TAKEAWAY', channel: 'POS', waiter: false })).toBe('COUNTER');
    expect(zoneOf({ type: 'DELIVERY', channel: 'TELEGRAM', waiter: false })).toBe('DELIVERY');
  });
});

describe('workflow enforcement on the restaurant server', () => {
  it('without a workflow nothing changes', async () => {
    const s = await setup(null);
    const placed = await post(s.waiter, '/orders', order(s, { tableId: s.table.id, place: true })).expect(201);
    expect(placed.body.status).toBe('PLACED');
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
    expect(row.workflow).toBeNull();
  });

  it('Fast food: payment first, then the kitchen; waiters do not take orders at the counter', async () => {
    const s = await setup(preset(2));
    const early = await post(s.cashier, '/orders', order(s, { type: 'TAKEAWAY', place: true })).expect(409);
    expect(early.body.code).toBe('WORKFLOW_PAYMENT_FIRST');
    const draft = await post(s.cashier, '/orders', order(s, { type: 'TAKEAWAY' })).expect(201);
    const id = draft.body.id as string;
    await pay(s, id, 10_000).expect(201);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
    await pay(s, id, 30_000).expect(201);
    const placed = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(placed.status).toBe('PLACED');
    // No kitchen confirmation in this mode: the ticket counts as accepted.
    expect(placed.kitchenAcceptedAt).not.toBeNull();
    expect(placed.workflow).toMatchObject({ zone: 'COUNTER', payment: 'PREPAY' });
    const refused = await post(s.waiter, '/orders', order(s, { tableId: s.table.id, place: true })).expect(403);
    expect(refused.body.code).toBe('WORKFLOW_SOURCE');
  });

  it('Cashier approval: the waiter’s order waits for the cashier', async () => {
    const s = await setup(preset(3));
    const sent = await post(s.waiter, '/orders', order(s, { tableId: s.table.id, place: true })).expect(201);
    expect(sent.body.status).toBe('PENDING');
    await post(s.waiter, `/orders/${sent.body.id}/approve`).expect(403);
    await post(s.cashier, `/orders/${sent.body.id}/approve`).expect(200);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: sent.body.id } })).status).toBe('PLACED');
  });

  it('QR ordering: the waiter approves the guest’s order', async () => {
    const s = await setup(preset(4));
    const guest = ctx.agent();
    const created = await post(guest, '/public/orders', {
      idempotencyKey: randomUUID(),
      source: { kind: 'table', token: s.table.qrToken },
      customerName: 'Mehmon',
      items: [{ variantId: s.variant.id, quantity: 1, price: 1 }],
    }).expect(201);
    const row = await ctx.db.order.findFirstOrThrow({ where: { trackingToken: created.body.trackingToken } });
    expect(row.status).toBe('PENDING');
    expect(row.workflow).toMatchObject({ zone: 'QR', approval: 'WAITER' });
    await post(s.waiter, `/orders/${row.id}/approve`).expect(200);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PLACED');
  });

  it('Advance payment: the kitchen gets the order once the advance is in', async () => {
    const s = await setup(preset(16));
    const draft = await post(s.cashier, '/orders', order(s, { type: 'TAKEAWAY' })).expect(201);
    const id = draft.body.id as string;
    await pay(s, id, 15_000).expect(201);
    const early = await post(s.cashier, `/orders/${id}/place`).expect(409);
    expect(early.body.code).toBe('WORKFLOW_ADVANCE');
    await pay(s, id, 5_000).expect(201);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id } })).status).toBe('PLACED');
  });

  it('Table service keeps orders off the queue TV; VIP rooms limit discounts to managers', async () => {
    const s = await setup(preset(7));
    const sent = await post(s.waiter, '/orders', order(s, { tableId: s.table.id, place: true })).expect(201);
    expect(sent.body.status).toBe('PLACED');
    const queue = await s.cashier.get('/api/queue').expect(200);
    expect(queue.body.preparing).not.toContain(sent.body.number);

    const vip = await setup(preset(13), 'VIP');
    const vipOrder = await post(vip.waiter, '/orders', order(vip, { tableId: vip.table.id, place: true })).expect(201);
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: vipOrder.body.id } });
    expect(row.workflow).toMatchObject({ zone: 'VIP', discounts: 'MANAGER' });
    const discount = { percentBp: 1_000, reason: 'Doimiy mijoz' };
    const refused = await post(vip.cashier, `/orders/${row.id}/discount`, discount);
    expect([403]).toContain(refused.status);
    await post(vip.owner, `/orders/${row.id}/discount`, discount).expect(200);
  });

  it('open orders keep the workflow version they were created with', async () => {
    const s = await setup(preset(7));
    const sent = await post(s.waiter, '/orders', order(s, { tableId: s.table.id, place: true })).expect(201);
    await storeWorkflow(ctx.db, s.tenantId, { version: ++version, config: preset(2) });
    const row = await ctx.db.order.findUniqueOrThrow({ where: { id: sent.body.id } });
    expect(row.workflow).toMatchObject({ zone: 'HALL', payment: 'POSTPAY' });
    // A new order follows the new mode.
    const refused = await post(s.waiter, '/orders', order(s, { type: 'TAKEAWAY', place: true })).expect(403);
    expect(refused.body.code).toBe('WORKFLOW_SOURCE');
  });
});
