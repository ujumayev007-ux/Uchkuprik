import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueKitchenTickets } from '../src/printing/queue.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(async () => {
  // Unreachable test printers must not crowd the shared print queue.
  await ctx.db.printJob.updateMany({
    where: { status: 'PENDING', printer: { name: 'Somsa printer D' } },
    data: { status: 'FAILED' },
  });
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  return { tenant, tenantId: tenant.tenant.id, owner };
}

describe('department ticket templates', () => {
  it('prints header, footer and copies for the department', async () => {
    const s = await setup();
    const station = await post(s.owner, '/kitchen/stations', {
      name: 'Somsa',
    }).expect(201);
    await ctx.db.printer.create({
      data: {
        tenantId: s.tenantId,
        branchId: s.tenant.branch.id,
        name: 'Somsa printer D',
        kind: 'KITCHEN',
        stationId: station.body.id,
        host: '127.0.0.1',
        port: 1,
      },
    });
    await put(s.owner, `/kitchen/stations/${station.body.id}/template`, {
      header: 'SOMSAXONA',
      footer: 'Issiq holda bering',
      copies: 2,
      showWaiter: false,
    }).expect(200);
    const test = await post(
      s.owner,
      `/kitchen/stations/${station.body.id}/test-print`,
    ).expect(200);
    expect(test.body.printers).toBe(1);

    const category = await post(s.owner, '/menu/categories', {
      name: 'Somsalar',
      stationId: station.body.id,
    }).expect(201);
    const product = await post(s.owner, '/menu/products', {
      categoryId: category.body.id,
      name: 'Somsa',
      variants: [{ name: 'Standart', price: 8000 }],
    }).expect(201);
    const variant = await ctx.db.productVariant.findFirstOrThrow({
      where: { productId: product.body.id },
    });
    const order = await post(s.owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: variant.id, quantity: 3 }],
    }).expect(201);
    await enqueueKitchenTickets(ctx.services, order.body.id);
    const job = await ctx.db.printJob.findFirstOrThrow({
      where: { orderId: order.body.id },
    });
    const text = Buffer.from(job.payload).toString('latin1');
    expect(text.split('SOMSAXONA')).toHaveLength(3); // two copies
    expect(text).toContain('Issiq holda bering');
    expect(text).not.toContain('Ofitsiant:');
  });
});

describe('supplier returns and stock requests', () => {
  it('returns goods to a supplier and runs requests through approval', async () => {
    const s = await setup();
    await addUser(ctx, s.tenantId, {
      username: 'oshpaz',
      roleIds: [s.tenant.roleId('kitchen')],
    });
    const cook = ctx.agent();
    await login(cook, s.tenant.slug, 'oshpaz').expect(200);
    const bought = await post(s.owner, '/purchases/market', {
      supplierName: 'Go‘sht do‘koni',
      paid: false,
      lines: [
        {
          newItem: { name: 'Go‘sht', baseUnit: 'G' },
          quantity: '5',
          unitName: 'kg',
          lineTotal: 500000,
        },
      ],
    }).expect(201);
    const item = await ctx.db.stockItem.findFirstOrThrow({
      where: { tenantId: s.tenantId, name: 'Go‘sht' },
    });
    const supplier = await ctx.db.supplier.findFirstOrThrow({
      where: { tenantId: s.tenantId, name: 'Go‘sht do‘koni' },
    });
    await post(s.owner, `/suppliers/${supplier.id}/returns`, {
      purchaseId: bought.body.id,
      reason: 'Sifatsiz',
      lines: [
        { stockItemId: item.id, quantity: '9', unitName: 'kg', amount: 1 },
      ],
    }).expect(409); // more than in stock
    await post(s.owner, `/suppliers/${supplier.id}/returns`, {
      purchaseId: bought.body.id,
      reason: 'Sifatsiz',
      lines: [
        { stockItemId: item.id, quantity: '1', unitName: 'kg', amount: 100000 },
      ],
    }).expect(201);
    const suppliers = await s.owner.get('/api/suppliers').expect(200);
    const row = suppliers.body.suppliers.find(
      (entry: { id: string }) => entry.id === supplier.id,
    );
    expect(row).toMatchObject({ returned: 100000, debt: 400000 });
    const balance = await ctx.db.stockBalance.findFirstOrThrow({
      where: { stockItemId: item.id },
    });
    expect(Number(balance.quantity)).toBe(4000);

    // The cook asks for stock; only a manager (not the requester) decides.
    const request = await post(cook, '/inventory/requests', {
      items: [{ stockItemId: item.id, quantity: '3', unitName: 'kg' }],
      note: 'Ertaga uchun',
    }).expect(201);
    await post(cook, `/inventory/requests/${request.body.id}/decide`, {
      decision: 'APPROVED',
    }).expect(403);
    await post(s.owner, `/inventory/requests/${request.body.id}/decide`, {
      decision: 'APPROVED',
    }).expect(200);
    await post(s.owner, '/purchases/market', {
      requestIds: [request.body.id],
      lines: [
        {
          stockItemId: item.id,
          quantity: '3',
          unitName: 'kg',
          lineTotal: 300000,
        },
      ],
    }).expect(201);
    const done = await ctx.db.stockRequest.findUniqueOrThrow({
      where: { id: request.body.id },
    });
    expect(done.status).toBe('FULFILLED');
    const mine = await cook.get('/api/inventory/requests').expect(200);
    expect(mine.body.requests).toHaveLength(1);

    // Low-stock alert turns into a request.
    await ctx.db.stockItem.update({
      where: { id: item.id },
      data: { minStock: 10000 },
    });
    const fromAlerts = await post(
      s.owner,
      '/inventory/requests/from-alerts',
    ).expect(201);
    expect(fromAlerts.body.items).toBe(1);
  });
});
