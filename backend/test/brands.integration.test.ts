import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);
const today = new Date().toISOString().slice(0, 10);

async function product(tenantId: string, categoryId: string, name: string) {
  const created = await ctx.db.product.create({
    data: { tenantId, categoryId, name },
  });
  return ctx.db.productVariant.create({
    data: { tenantId, productId: created.id, name: 'Standart', price: 30000 },
  });
}

describe('brands', () => {
  it('scopes menus, prices and receipts to the branch brand', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);

    const burgers = await post(owner, '/brands', {
      code: 'burger-house',
      name: 'Burger House',
      primaryColor: '#c2410c',
      receiptHeader: 'Burger House — mazali!',
    }).expect(201);
    const pizza = await post(owner, '/brands', {
      code: 'pizza-uno',
      name: 'Pizza Uno',
    }).expect(201);
    expect(
      (await post(owner, '/brands', { code: 'pizza-uno', name: 'Takror' }))
        .status,
    ).toBe(409);
    expect(
      (
        await post(owner, '/brands', {
          code: 'yomon',
          name: 'Yomon',
          primaryColor: 'red',
        })
      ).status,
    ).toBe(400);

    // Main branch trades as Burger House; a second branch as Pizza Uno.
    const main = tenant.branch;
    await patch(owner, `/branches/${main.id}`, {
      code: main.code,
      name: main.name,
      brandId: burgers.body.id,
    }).expect(200);
    const second = await post(owner, '/branches', {
      code: 'chilonzor',
      name: 'Chilonzor',
      brandId: pizza.body.id,
    }).expect(201);

    // A brand from another tenant is rejected.
    const other = await createTenant(ctx);
    const foreign = await ctx.db.brand.create({
      data: { tenantId: other.tenant.id, code: 'begona', name: 'Begona' },
    });
    expect(
      (
        await post(owner, '/branches', {
          code: 'begona',
          name: 'Begona',
          brandId: foreign.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(owner, '/menu/categories', {
          name: 'Begona',
          brandId: foreign.id,
        })
      ).status,
    ).toBe(400);

    const shared = await post(owner, '/menu/categories', {
      name: 'Ichimliklar',
    }).expect(201);
    const burgerCat = await post(owner, '/menu/categories', {
      name: 'Burgerlar',
      brandId: burgers.body.id,
    }).expect(201);
    const pizzaCat = await post(owner, '/menu/categories', {
      name: 'Pitsalar',
      brandId: pizza.body.id,
    }).expect(201);
    const cola = await product(tenantId, shared.body.id, 'Kola');
    const burger = await product(tenantId, burgerCat.body.id, 'Burger');
    const margherita = await product(tenantId, pizzaCat.body.id, 'Margarita');

    const mainMenu = await owner
      .get(`/api/menu?branchId=${main.id}`)
      .expect(200);
    const names = (menu: { body: { products: { name: string }[] } }) =>
      menu.body.products.map((item) => item.name).sort();
    expect(names(mainMenu)).toEqual(['Burger', 'Kola']);
    const pizzaMenu = await owner
      .get(`/api/menu?branchId=${second.body.id}`)
      .expect(200);
    expect(names(pizzaMenu)).toEqual(['Kola', 'Margarita']);
    // The editor still sees every category with its brand.
    const editor = await owner
      .get(`/api/menu?branchId=${main.id}&all=true`)
      .expect(200);
    expect(
      editor.body.categories.find(
        (category: { id: string }) => category.id === pizzaCat.body.id,
      ).brandId,
    ).toBe(pizza.body.id);

    // Pricing is server-side: another brand's product cannot be sold here.
    const blocked = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      branchId: main.id,
      type: 'TAKEAWAY',
      items: [{ variantId: margherita.id, quantity: 1 }],
    });
    expect(blocked.body.code).toBe('ITEM_UNAVAILABLE');
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      branchId: main.id,
      type: 'TAKEAWAY',
      items: [
        { variantId: burger.id, quantity: 1 },
        { variantId: cola.id, quantity: 1 },
      ],
    }).expect(201);
    const receipt = await owner
      .get(`/api/orders/${order.body.order?.id ?? order.body.id}/receipt`)
      .expect(200);
    expect(receipt.body.business.name).toBe('Burger House');
    expect(receipt.body.business.header).toBe('Burger House — mazali!');

    // The public storefront shows each branch's brand and only its menu.
    await ctx.db.tenantProfile.upsert({
      where: { tenantId },
      update: { publicOrdering: true },
      create: { tenantId, publicOrdering: true },
    });
    const site = await ctx
      .agent()
      .get(`/api/public/r/${tenant.slug}`)
      .expect(200);
    expect(
      site.body.branches.find((b: { id: string }) => b.id === main.id).brand,
    ).toMatchObject({ name: 'Burger House', primaryColor: '#c2410c' });
    const publicMenu = await ctx
      .agent()
      .get(`/api/public/r/${tenant.slug}/menu?branchId=${second.body.id}`)
      .expect(200);
    expect(names(publicMenu)).toEqual(['Kola', 'Margarita']);

    const brands = await owner.get('/api/brands').expect(200);
    expect(
      brands.body.brands.map((brand: { code: string }) => brand.code),
    ).toEqual(['burger-house', 'pizza-uno']);
    const report = await owner
      .get(`/api/reports/brands?from=${today}&to=${today}`)
      .expect(200);
    expect(
      report.body.brands.map((row: { brandName: string }) => row.brandName),
    ).toEqual(['Burger House', 'Pizza Uno']);

    await put(owner, `/brands/${pizza.body.id}`, {
      code: 'pizza-uno',
      name: 'Pizza Uno Express',
      isActive: false,
    }).expect(200);
    const audit = await ctx.db.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'brand.' } },
    });
    expect(audit).toHaveLength(3);
  });

  it('requires brands.manage and the multi-brand plan feature', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const basic = await ctx.db.plan.findUniqueOrThrow({
      where: { code: 'BASIC' },
    });
    await ctx.db.subscription.create({
      data: {
        tenantId: tenant.tenant.id,
        planId: basic.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const gated = await post(owner, '/brands', { code: 'abc', name: 'Abc' });
    expect(gated.body.code).toBe('FEATURE_NOT_IN_PLAN');

    const unrestricted = await createTenant(ctx);
    const { addUser } = await import('./helpers.js');
    await addUser(ctx, unrestricted.tenant.id, {
      username: 'kassir',
      roleIds: [unrestricted.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, unrestricted.slug, 'kassir').expect(200);
    await post(cashier, '/brands', { code: 'abc', name: 'Abc' }).expect(403);
  });
});
