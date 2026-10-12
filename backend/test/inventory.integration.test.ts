import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
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
const send = (
  agent: Agent,
  method: 'post' | 'patch' | 'put',
  path: string,
  body: object = {},
) => agent[method](`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const meat = await send(owner, 'post', '/inventory/items', {
    name: 'Mol go‘shti',
    baseUnit: 'G',
    minStock: 20000,
    units: [{ name: 'kg', factor: 1000 }],
  }).expect(201);
  const supplier = await send(owner, 'post', '/suppliers', {
    name: 'Go‘sht savdo',
  }).expect(201);
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taomlar' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Burger' },
  });
  const burger = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Standart', price: 40000 },
  });
  await send(owner, 'put', `/recipes/${burger.id}`, {
    lines: [{ stockItemId: meat.body.id, quantity: '150' }],
  }).expect(200);
  return {
    tenant,
    tenantId,
    owner,
    meatId: meat.body.id as string,
    supplierId: supplier.body.id as string,
    burger,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function receive(s: Setup, kg: string, pricePerKg: number) {
  const purchase = await send(s.owner, 'post', '/purchases', {
    supplierId: s.supplierId,
    invoiceNo: `INV-${randomUUID().slice(0, 6)}`,
    lines: [
      {
        stockItemId: s.meatId,
        quantity: kg,
        unitName: 'kg',
        unitPrice: pricePerKg,
      },
    ],
  }).expect(201);
  await send(s.owner, 'post', `/purchases/${purchase.body.id}/receive`).expect(
    200,
  );
  return purchase.body.id as string;
}

const balance = async (s: Setup, branchId = s.tenant.branch.id) => {
  const items = await s.owner
    .get(`/api/inventory/items?branchId=${branchId}`)
    .expect(200);
  return items.body.items.find((item: { id: string }) => item.id === s.meatId);
};

async function sellBurgers(s: Setup, quantity: number) {
  const order = await send(s.owner, 'post', '/orders', {
    idempotencyKey: randomUUID(),
    type: 'TAKEAWAY',
    items: [{ variantId: s.burger.id, quantity }],
  }).expect(201);
  const shift = await s.owner.get('/api/shifts/current').expect(200);
  if (!shift.body.shift)
    await send(s.owner, 'post', '/shifts/open', { openingCash: 0 }).expect(201);
  await send(s.owner, 'post', `/orders/${order.body.id}/payments`, {
    idempotencyKey: randomUUID(),
    method: 'CARD',
    amount: order.body.total,
  }).expect(201);
  return send(s.owner, 'post', `/orders/${order.body.id}/complete`).then(
    (response) => ({ response, id: order.body.id as string }),
  );
}

describe('purchasing and costing', () => {
  it('receives purchases in packaging units with weighted average cost and supplier debt', async () => {
    const s = await setup();
    const first = await receive(s, '10', 80000); // 10 kg at 80 000 so‘m/kg = 80 so‘m/g
    await receive(s, '5', 95000); // 5 kg at 95 000 so‘m/kg
    expect(await balance(s)).toMatchObject({
      quantity: '15000',
      avgCost: '85',
      value: 1275000,
      low: true,
    });
    await send(s.owner, 'post', `/purchases/${first}/receive`).expect(409);

    await send(s.owner, 'post', `/suppliers/${s.supplierId}/payments`, {
      amount: 500000,
    }).expect(201);
    const suppliers = await s.owner.get('/api/suppliers').expect(200);
    expect(suppliers.body.suppliers[0]).toMatchObject({
      purchased: 1275000,
      paid: 500000,
      debt: 775000,
    });

    const unknownUnit = await send(s.owner, 'post', '/purchases', {
      supplierId: s.supplierId,
      lines: [
        {
          stockItemId: s.meatId,
          quantity: '1',
          unitName: 'tonna',
          unitPrice: 1,
        },
      ],
    });
    expect(unknownUnit.body.code).toBe('UNKNOWN_UNIT');
  });
});

describe('recipe deductions', () => {
  it('deducts ingredients once when an order is completed', async () => {
    const s = await setup();
    await receive(s, '15', 85000);
    const { response, id } = await sellBurgers(s, 2);
    expect(response.status).toBe(200);
    expect((await balance(s)).quantity).toBe('14700');
    const movements = await ctx.db.stockMovement.findMany({
      where: { referenceType: 'order', referenceId: id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity.toString()).toBe('-300');
    expect(movements[0]!.unitCost.toString()).toBe('85');
    // A completed order cannot complete (and deduct) twice.
    await send(s.owner, 'post', `/orders/${id}/complete`).expect(409);
    expect((await balance(s)).quantity).toBe('14700');
  });

  it('rejects completion that would make stock negative when the policy forbids it', async () => {
    const s = await setup();
    await ctx.db.tenantProfile.create({
      data: { tenantId: s.tenantId, allowNegativeStock: false },
    });
    await receive(s, '0.2', 80000); // 200 g: enough for one burger only
    const { response, id } = await sellBurgers(s, 2);
    expect(response.body.code).toBe('INSUFFICIENT_STOCK');
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id } });
    expect(order.status).toBe('PLACED');
    expect((await balance(s)).quantity).toBe('200');
  });
});

describe('waste, stocktake and transfers', () => {
  it('keeps the ledger consistent with balances', async () => {
    const s = await setup();
    await receive(s, '10', 80000);
    await send(s.owner, 'post', '/inventory/adjustments', {
      type: 'WASTE',
      reason: 'Muddati o‘tdi',
      lines: [{ stockItemId: s.meatId, quantity: '500' }],
    }).expect(201);
    expect((await balance(s)).quantity).toBe('9500');
    const counted = await send(s.owner, 'post', '/inventory/stocktakes', {
      counts: [{ stockItemId: s.meatId, counted: '9400.5' }],
    }).expect(201);
    expect(counted.body.differences).toEqual([
      { stockItemId: s.meatId, difference: '-99.5' },
    ]);
    const sum = await ctx.db.stockMovement.aggregate({
      where: { stockItemId: s.meatId },
      _sum: { quantity: true },
    });
    expect(sum._sum.quantity?.toString()).toBe('9400.5');
    const last = await ctx.db.stockMovement.findFirstOrThrow({
      where: { stockItemId: s.meatId },
      orderBy: { id: 'desc' },
    });
    expect(last.balanceAfter.toString()).toBe('9400.5');

    const second = await ctx.db.branch.create({
      data: { tenantId: s.tenantId, code: 'sergeli', name: 'Sergeli' },
    });
    await send(s.owner, 'post', '/inventory/transfers', {
      toBranchId: second.id,
      lines: [{ stockItemId: s.meatId, quantity: '2000' }],
    }).expect(201);
    expect((await balance(s)).quantity).toBe('7400.5');
    expect(await balance(s, second.id)).toMatchObject({
      quantity: '2000',
      avgCost: '80',
    });
    await send(s.owner, 'post', '/inventory/transfers', {
      toBranchId: s.tenant.branch.id,
      lines: [{ stockItemId: s.meatId, quantity: '1' }],
    }).expect(400);
  });

  it('serializes concurrent withdrawals so stock never goes below zero when forbidden', async () => {
    const s = await setup();
    await ctx.db.tenantProfile.create({
      data: { tenantId: s.tenantId, allowNegativeStock: false },
    });
    await receive(s, '3', 80000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        send(s.owner, 'post', '/inventory/adjustments', {
          type: 'WASTE',
          reason: 'Sinov',
          lines: [{ stockItemId: s.meatId, quantity: '1000' }],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(
      results.filter((r) => r.body.code === 'INSUFFICIENT_STOCK'),
    ).toHaveLength(2);
    expect((await balance(s)).quantity).toBe('0');
  });

  it('reports low stock with a reorder suggestion', async () => {
    const s = await setup();
    await receive(s, '5', 80000);
    const alerts = await s.owner.get('/api/inventory/alerts').expect(200);
    expect(alerts.body.alerts).toEqual([
      expect.objectContaining({
        stockItemId: s.meatId,
        quantity: '5000',
        minStock: '20000',
        suggestedOrder: '35000',
      }),
    ]);
  });
});

describe('inventory security', () => {
  it('enforces permissions, hides costs and isolates tenants', async () => {
    const s = await setup();
    await receive(s, '1', 80000);
    await addUser(ctx, s.tenantId, {
      username: 'kassir',
      roleIds: [s.tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, s.tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/inventory/items').expect(403);

    const viewer = await send(s.owner, 'post', '/roles', {
      name: 'Ombor kuzatuvchi',
      permissions: ['inventory.view'],
    }).expect(201);
    await addUser(ctx, s.tenantId, {
      username: 'kuzatuvchi',
      roleIds: [viewer.body.id],
    });
    const watcher = ctx.agent();
    await login(watcher, s.tenant.slug, 'kuzatuvchi').expect(200);
    const view = await watcher.get('/api/inventory/items').expect(200);
    expect(view.body.items[0].quantity).toBe('1000');
    expect(JSON.stringify(view.body)).not.toMatch(/avgCost|value/);
    await send(watcher, 'post', '/inventory/adjustments', {
      type: 'WASTE',
      reason: 'Sinov',
      lines: [{ stockItemId: s.meatId, quantity: '1' }],
    }).expect(403);

    const other = await setup();
    await send(other.owner, 'put', `/recipes/${other.burger.id}`, {
      lines: [{ stockItemId: s.meatId, quantity: '1' }],
    }).expect(400);
    await send(other.owner, 'post', '/purchases', {
      supplierId: s.supplierId,
      lines: [
        {
          stockItemId: other.meatId,
          quantity: '1',
          unitName: 'kg',
          unitPrice: 1,
        },
      ],
    }).expect(400);
    await expect(
      ctx.db
        .$executeRaw`UPDATE stock_movements SET quantity = 1 WHERE "stockItemId" = ${s.meatId}::uuid`,
    ).rejects.toThrow();
  });
});
