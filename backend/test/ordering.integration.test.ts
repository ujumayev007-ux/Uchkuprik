import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createEventBus } from '../src/realtime/bus.js';
import { generateIdentity } from '../src/modules/control/keys.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
} from './helpers.js';

// Central ordering controls: order types, the «Mijoz» button, table assignment,
// discount limits per role, display/TV/alert settings and their delegation.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
ctx.services.events = createEventBus();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;

const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup(features: Record<string, unknown> = {}) {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Lavash' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Oddiy', price: 50_000 },
  });
  const room = await ctx.db.room.create({
    data: { tenantId, branchId: branch.id, name: 'Zal' },
  });
  const makeTable = (name: string) =>
    ctx.db.diningTable.create({
      data: {
        tenantId,
        branchId: branch.id,
        roomId: room.id,
        name,
        qrToken: unique('qr'),
      },
    });
  const table1 = await makeTable('1-stol');
  const table2 = await makeTable('2-stol');
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
    data: { customerId: customer.id, features: features as object },
  });
  clearPolicyCache();
  clearAdminSettingsCache();
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  const waiter = ctx.agent();
  await login(waiter, tenant.slug, 'ofitsiant').expect(200);
  const setFeatures = async (next: Record<string, unknown>) => {
    await ctx.db.controlPolicy.update({
      where: { customerId: customer.id },
      data: { features: next as object, version: { increment: 1 } },
    });
    clearPolicyCache();
    clearAdminSettingsCache();
  };
  return {
    tenant,
    tenantId,
    variant,
    table1,
    table2,
    owner,
    cashier,
    waiter,
    setFeatures,
  };
}

const orderBody = (variantId: string, extra: object = {}) => ({
  idempotencyKey: randomUUID(),
  type: 'DINE_IN',
  items: [{ variantId, quantity: 2 }],
  ...extra,
});

describe('/me ordering settings', () => {
  it('gives everything by default and resolves roles separately', async () => {
    const s = await setup({
      'discounts.percent': {
        params: { maxPercent: 50 },
        roles: { cashier: { params: { maxPercent: 10 } } },
      },
      'orders.display': {
        params: { defaultMode: 'compact' },
        roles: { waiter: { enabled: false } },
      },
    });
    const cashier = (await s.cashier.get('/api/auth/me').expect(200)).body;
    expect(cashier.ordering.types).toEqual({
      DINE_IN: true,
      TAKEAWAY: true,
      DELIVERY: true,
    });
    expect(cashier.ordering.walkin).toBe(true);
    expect(cashier.ordering.discount.maxPercentBp).toBe(1000);
    expect(cashier.ordering.display).toEqual({
      mode: 'compact',
      canChange: true,
    });
    const owner = (await s.owner.get('/api/auth/me').expect(200)).body;
    expect(owner.ordering.discount.maxPercentBp).toBe(5000);
    const waiter = (await s.waiter.get('/api/auth/me').expect(200)).body;
    expect(waiter.ordering.display.canChange).toBe(false);
    // Waiters are the audience of new-guest alerts; cashiers are not.
    expect(waiter.ordering.waiterAlerts.enabled).toBe(true);
    expect(cashier.ordering.waiterAlerts.enabled).toBe(false);
  });
});

describe('order types and the «Mijoz» button', () => {
  it('lets the cashier create a guest order without a table and announces it', async () => {
    const s = await setup();
    const events: unknown[] = [];
    const unsubscribe = ctx.services.events?.subscribe((event) =>
      events.push(event),
    );
    const created = await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id, { place: true }),
    ).expect(201);
    unsubscribe?.();
    expect(created.body.table).toBeNull();
    expect(created.body.type).toBe('DINE_IN');
    expect(
      (events as { type: string }[]).some(
        (event) => event.type === 'order.table_needed',
      ),
    ).toBe(true);
  });

  it('refuses types and the Mijoz button the Owner switched off for the role', async () => {
    const s = await setup({
      'orders.walkin': { roles: { cashier: { enabled: false } } },
      'orders.type.delivery': { mode: 'OFF' },
    });
    const noWalkin = await post(s.cashier, '/orders', orderBody(s.variant.id));
    expect(noWalkin.status).toBe(403);
    expect(noWalkin.body.code).toBe('FEATURE_DISABLED');
    // The same order with a table is fine.
    await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id, { tableId: s.table1.id }),
    ).expect(201);
    const delivery = await post(
      s.owner,
      '/orders',
      orderBody(s.variant.id, {
        type: 'DELIVERY',
        deliveryAddress: 'Toshkent',
        customerPhone: '+998901234567',
      }),
    );
    expect(delivery.status).toBe(403);
    // The owner role is not affected by the cashier override.
    await post(s.owner, '/orders', orderBody(s.variant.id)).expect(201);
  });
});

describe('table assignment', () => {
  it('assigns and changes the table without losing items or payments', async () => {
    const s = await setup();
    const created = await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id, { place: true }),
    ).expect(201);
    const id = created.body.id as string;
    const events: { type: string }[] = [];
    const unsubscribe = ctx.services.events?.subscribe((event) =>
      events.push(event),
    );
    // The waiter assigns the table.
    const assigned = await post(s.waiter, `/orders/${id}/table`, {
      tableId: s.table1.id,
    }).expect(200);
    expect(assigned.body.table.name).toBe('1-stol');
    expect(assigned.body.items).toHaveLength(1);
    expect(assigned.body.total).toBe(created.body.total);
    // The cashier changes it later.
    const moved = await post(s.cashier, `/orders/${id}/table`, {
      tableId: s.table2.id,
    }).expect(200);
    expect(moved.body.table.name).toBe('2-stol');
    unsubscribe?.();
    expect(
      events.filter((e) => e.type === 'order.table_assigned'),
    ).toHaveLength(2);
    // Both changes are in the audit log and in the order history.
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, action: 'order.table.assign' },
    });
    expect(audits).toHaveLength(2);
    const history = await ctx.db.orderEvent.findMany({
      where: { orderId: id, type: 'table_assigned' },
    });
    expect(history).toHaveLength(2);
    // Takeaway orders have no table.
    const takeaway = await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id, { type: 'TAKEAWAY' }),
    ).expect(201);
    const refused = await post(s.cashier, `/orders/${takeaway.body.id}/table`, {
      tableId: s.table1.id,
    });
    expect(refused.status).toBe(400);
  });

  it('is blocked for roles the Owner switched it off for, on both routes', async () => {
    const s = await setup({
      'orders.table.assign': { roles: { waiter: { enabled: false } } },
    });
    const created = await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id),
    ).expect(201);
    const viaRoute = await post(s.waiter, `/orders/${created.body.id}/table`, {
      tableId: s.table1.id,
    });
    expect(viaRoute.status).toBe(403);
    const viaPatch = await patch(s.waiter, `/orders/${created.body.id}`, {
      tableId: s.table1.id,
    });
    expect(viaPatch.status).toBe(403);
    // Notes can still be edited by the waiter and are audited.
    await patch(s.waiter, `/orders/${created.body.id}`, {
      note: 'Sovuq bo‘lsin',
    }).expect(200);
    expect(
      await ctx.db.auditLog.count({
        where: { tenantId: s.tenantId, action: 'order.update' },
      }),
    ).toBe(1);
  });
});

describe('discounts', () => {
  it('applies percent and fixed discounts within the role limits', async () => {
    const s = await setup({
      'discounts.percent': {
        params: { maxPercent: 30 },
        roles: { owner: { params: { maxPercent: 30 } } },
      },
      'discounts.fixed': { params: { maxFixed: 5_000 } },
    });
    const created = await post(
      s.owner,
      '/orders',
      orderBody(s.variant.id, { tableId: s.table1.id }),
    ).expect(201);
    const id = created.body.id as string;
    const subtotal = created.body.subtotal as number;
    const over = await post(s.owner, `/orders/${id}/discount`, {
      percentBp: 3_500,
      reason: 'Doimiy mijoz',
    });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('DISCOUNT_LIMIT');
    const ok = await post(s.owner, `/orders/${id}/discount`, {
      percentBp: 1_000,
      reason: 'Doimiy mijoz',
    }).expect(200);
    expect(ok.body.discountTotal).toBe(Math.round(subtotal * 0.1));
    const tooMuch = await post(s.owner, `/orders/${id}/discount`, {
      fixed: 10_000,
      reason: 'Doimiy mijoz',
    });
    expect(tooMuch.status).toBe(403);
    const fixed = await post(s.owner, `/orders/${id}/discount`, {
      fixed: 5_000,
      reason: 'Doimiy mijoz',
    }).expect(200);
    expect(fixed.body.discountTotal).toBe(5_000);
    expect(fixed.body.total).toBe(
      subtotal + (fixed.body.serviceCharge as number) - 5_000,
    );
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId: s.tenantId, action: 'order.discount' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
  });

  it('refuses a discount type that is switched off', async () => {
    const s = await setup({ 'discounts.fixed': { mode: 'OFF' } });
    const created = await post(
      s.owner,
      '/orders',
      orderBody(s.variant.id),
    ).expect(201);
    const refused = await post(s.owner, `/orders/${created.body.id}/discount`, {
      fixed: 1_000,
      reason: 'Sabab bor',
    });
    expect(refused.status).toBe(403);
    await post(s.owner, `/orders/${created.body.id}/discount`, {
      percentBp: 500,
      reason: 'Sabab bor',
    }).expect(200);
  });
});

describe('delegation to the restaurant Admin', () => {
  it('lets the Admin set delegated values but never above the Owner cap', async () => {
    const s = await setup({
      'discounts.percent': { mode: 'ADMIN', params: { maxPercent: 20 } },
    });
    const features = await s.owner
      .get('/api/control/link/features')
      .expect(200);
    const feature = features.body.features.find(
      (item: { key: string }) => item.key === 'discounts.percent',
    );
    expect(feature.params[0].key).toBe('maxPercent');
    // The Admin lowers the limit for cashiers.
    const lower = await s.owner
      .put('/api/control/link/features')
      .set('Origin', ORIGIN)
      .send({
        featureKey: 'discounts.percent',
        roleKey: 'cashier',
        params: { maxPercent: 5 },
      });
    expect(lower.status).toBe(200);
    // ...and tries to raise it for the owner role above the Owner's cap.
    await s.owner
      .put('/api/control/link/features')
      .set('Origin', ORIGIN)
      .send({
        featureKey: 'discounts.percent',
        roleKey: '*',
        params: { maxPercent: 90 },
      })
      .expect(200);
    const cashier = (await s.cashier.get('/api/auth/me').expect(200)).body;
    expect(cashier.ordering.discount.maxPercentBp).toBe(500);
    const owner = (await s.owner.get('/api/auth/me').expect(200)).body;
    expect(owner.ordering.discount.maxPercentBp).toBe(2000);
    // A feature the Owner did not delegate cannot be changed by the Admin.
    const refused = await s.owner
      .put('/api/control/link/features')
      .set('Origin', ORIGIN)
      .send({ featureKey: 'tv.voice', roleKey: '*', enabled: false });
    expect(refused.status).toBe(403);
  });
});

describe('customer TV and queue', () => {
  it('returns ids and display settings, and honours the TV switch', async () => {
    const s = await setup({
      'tv.display': { params: { layout: 'single', showPreparing: false } },
      'tv.voice': { params: { repeat: 2, phrase: 'cardinal' } },
    });
    const queue = await s.owner.get('/api/queue').expect(200);
    expect(queue.body.display.layout).toBe('single');
    expect(queue.body.display.showPreparing).toBe(false);
    expect(queue.body.display.voice.repeat).toBe(2);
    expect(queue.body.display.voice.phrase).toBe('cardinal');
    await s.setFeatures({ 'tv.display': { mode: 'OFF' } });
    const off = await s.owner.get('/api/queue');
    expect(off.status).toBe(403);
  });
});

describe('waiter alert stream', () => {
  it('is available to waiters only and sends config and the waiting guests', async () => {
    const s = await setup();
    const created = await post(
      s.cashier,
      '/orders',
      orderBody(s.variant.id, { place: true }),
    ).expect(201);
    const denied = await s.cashier.get('/api/live/alerts');
    expect(denied.status).toBe(403);
    const text = await new Promise<string>((resolve, reject) => {
      s.waiter
        .get('/api/live/alerts')
        .buffer(false)
        .parse((res, done) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            data += chunk;
            if (data.includes('event: snapshot')) {
              (res as unknown as { destroy: () => void }).destroy();
              done(null, data);
              resolve(data);
            }
          });
        })
        .end((error) => {
          if (error && !String(error).includes('aborted')) reject(error);
        });
    });
    expect(text).toContain('event: config');
    expect(text).toContain(created.body.id);
  });
});
