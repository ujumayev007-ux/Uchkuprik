import { afterAll, describe, expect, it } from 'vitest';
import { priceVariants } from '../src/modules/menu/pricing.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

async function ownerAgent() {
  const tenant = await createTenant(ctx);
  const agent = ctx.agent();
  await login(agent, tenant.slug, 'owner').expect(200);
  return { tenant, agent };
}

type Agent = ReturnType<typeof ctx.agent>;
const send = (
  agent: Agent,
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body?: object,
) =>
  agent[method](`/api${path}`)
    .set('Origin', ORIGIN)
    .send(body ?? {});

async function seedMenu(agent: Agent) {
  const category = await send(agent, 'post', '/menu/categories', {
    name: 'Burgerlar',
  }).expect(201);
  const product = await send(agent, 'post', '/menu/products', {
    categoryId: category.body.id,
    name: 'Chizburger',
    sku: 'BRG-1',
    variants: [
      { name: 'Kichik', price: 25000, cost: 11000 },
      { name: 'Katta', price: 32000, cost: 14000 },
    ],
  }).expect(201);
  return {
    categoryId: category.body.id as string,
    productId: product.body.id as string,
  };
}

describe('restaurant settings', () => {
  it('lets the owner update the profile and denies other roles', async () => {
    const { tenant, agent } = await ownerAgent();
    await send(agent, 'patch', '/settings', {
      name: 'Lazzat Burger',
      legalName: 'Lazzat MChJ',
      taxId: '123456789',
      phone: '+998 90 123 45 67',
      receiptFooter: 'Xaridingiz uchun rahmat!',
      serviceChargeBp: 1000,
      requireMfaForAdmins: false,
    }).expect(200);
    const settings = await agent.get('/api/settings').expect(200);
    expect(settings.body).toMatchObject({
      name: 'Lazzat Burger',
      taxId: '123456789',
      serviceChargeBp: 1000,
    });
    await send(agent, 'patch', '/settings', {
      name: 'X Y',
      serviceChargeBp: 5000,
      requireMfaForAdmins: false,
    }).expect(400);

    await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    await send(cashier, 'patch', '/settings', {
      name: 'Hack',
      serviceChargeBp: 0,
      requireMfaForAdmins: false,
    }).expect(403);
  });
});

describe('floor plan', () => {
  it('manages rooms and tables within the branch and hides QR tokens from staff', async () => {
    const { tenant, agent } = await ownerAgent();
    const room = await send(agent, 'post', '/rooms', {
      branchId: tenant.branch.id,
      name: 'Asosiy zal',
    }).expect(201);
    await send(agent, 'post', '/tables', {
      roomId: room.body.id,
      name: 'T1',
      seats: 4,
    }).expect(201);
    const duplicate = await send(agent, 'post', '/tables', {
      roomId: room.body.id,
      name: 'T1',
      seats: 2,
    });
    expect(duplicate.status).toBe(409);
    await send(agent, 'post', '/tables', {
      roomId: room.body.id,
      name: 'T2',
      seats: 0,
    }).expect(400);

    const floor = await agent
      .get(`/api/floor?branchId=${tenant.branch.id}`)
      .expect(200);
    expect(floor.body.rooms[0].tables[0].qrToken).toMatch(
      /^[A-Za-z0-9_-]{24}$/,
    );

    // A second branch's room cannot receive this branch's table.
    const other = await ctx.db.branch.create({
      data: {
        tenantId: tenant.tenant.id,
        code: 'yunusobod',
        name: 'Yunusobod',
      },
    });
    const otherRoom = await send(agent, 'post', '/rooms', {
      branchId: other.id,
      name: 'Zal',
    }).expect(201);
    const tableId = floor.body.rooms[0].tables[0].id;
    await send(agent, 'patch', `/tables/${tableId}`, {
      roomId: otherRoom.body.id,
      name: 'T1',
      seats: 4,
    }).expect(400);

    await addUser(ctx, tenant.tenant.id, {
      username: 'ofitsiant',
      roleIds: [tenant.roleId('waiter')],
    });
    const waiter = ctx.agent();
    await login(waiter, tenant.slug, 'ofitsiant').expect(200);
    const staffView = await waiter
      .get(`/api/floor?branchId=${tenant.branch.id}`)
      .expect(200);
    expect(staffView.body.rooms[0].tables[0].qrToken).toBeUndefined();
    await send(waiter, 'post', '/rooms', {
      branchId: tenant.branch.id,
      name: 'VIP',
    }).expect(403);

    // Another tenant's owner cannot touch the table.
    const intruder = await ownerAgent();
    await send(intruder.agent, 'patch', `/tables/${tableId}`, {
      roomId: room.body.id,
      name: 'X',
      seats: 2,
    }).expect(404);
  });
});

describe('menu', () => {
  it('hides internal costs from roles without menu.cost.view', async () => {
    const { tenant, agent } = await ownerAgent();
    await seedMenu(agent);
    // Login selects the first branch, so the menu resolves without an explicit branch.
    const ownerView = await agent.get('/api/menu').expect(200);
    expect(ownerView.body.branchId).toBe(tenant.branch.id);
    const withBranch = await agent
      .get(`/api/menu?branchId=${tenant.branch.id}`)
      .expect(200);
    expect(withBranch.body.products[0].variants[0].cost).toBe(11000);

    await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    const cashierView = await cashier
      .get(`/api/menu?branchId=${tenant.branch.id}`)
      .expect(200);
    expect(cashierView.body.products[0].variants[0].price).toBe(25000);
    expect(JSON.stringify(cashierView.body)).not.toContain('cost');
  });

  it('keeps stored costs when an editor without cost access saves a product', async () => {
    const { tenant, agent } = await ownerAgent();
    const { categoryId, productId } = await seedMenu(agent);
    const role = await send(agent, 'post', '/roles', {
      name: 'Menyu muharriri',
      permissions: ['menu.view', 'menu.manage'],
    }).expect(201);
    await addUser(ctx, tenant.tenant.id, {
      username: 'muharrir',
      roleIds: [role.body.id],
    });
    const editor = ctx.agent();
    await login(editor, tenant.slug, 'muharrir').expect(200);
    const menu = await editor
      .get(`/api/menu?branchId=${tenant.branch.id}&all=true`)
      .expect(200);
    const variants = menu.body.products[0].variants;
    await send(editor, 'patch', `/menu/products/${productId}`, {
      categoryId,
      name: 'Chizburger',
      sku: 'BRG-1',
      variants: variants.map((variant: { id: string; name: string }) => ({
        id: variant.id,
        name: variant.name,
        price: 27000,
        cost: 1,
      })),
    }).expect(200);
    const stored = await ctx.db.productVariant.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(stored.map((variant) => variant.cost)).toEqual([11000, 14000]);
    expect(stored.map((variant) => variant.price)).toEqual([27000, 27000]);
    const product = await ctx.db.product.findUniqueOrThrow({
      where: { id: productId },
    });
    expect(product.version).toBe(2);
  });

  it('applies branch prices and availability through the server pricing service', async () => {
    const { tenant, agent } = await ownerAgent();
    const { productId } = await seedMenu(agent);
    const second = await ctx.db.branch.create({
      data: { tenantId: tenant.tenant.id, code: 'sergeli', name: 'Sergeli' },
    });
    const [small, large] = await ctx.db.productVariant.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
    });
    await send(agent, 'put', '/menu/branch-prices', {
      branchId: tenant.branch.id,
      items: [
        { variantId: small!.id, price: 23000, isAvailable: true },
        { variantId: large!.id, price: null, isAvailable: false },
      ],
    }).expect(200);
    const main = await priceVariants(
      ctx.db,
      tenant.tenant.id,
      tenant.branch.id,
      [small!.id, large!.id],
    );
    expect(main.get(small!.id)).toMatchObject({
      price: 23000,
      available: true,
    });
    expect(main.get(large!.id)).toMatchObject({
      price: 32000,
      available: false,
    });
    const other = await priceVariants(ctx.db, tenant.tenant.id, second.id, [
      small!.id,
    ]);
    expect(other.get(small!.id)).toMatchObject({
      price: 25000,
      available: true,
    });

    // Clearing the override restores the base price.
    await send(agent, 'put', '/menu/branch-prices', {
      branchId: tenant.branch.id,
      items: [{ variantId: small!.id, price: null, isAvailable: true }],
    }).expect(200);
    const restored = await priceVariants(
      ctx.db,
      tenant.tenant.id,
      tenant.branch.id,
      [small!.id],
    );
    expect(restored.get(small!.id)?.price).toBe(25000);
  });

  it('validates category trees, variants and modifier groups', async () => {
    const { agent } = await ownerAgent();
    const parent = await send(agent, 'post', '/menu/categories', {
      name: 'Ichimliklar',
    }).expect(201);
    const child = await send(agent, 'post', '/menu/categories', {
      name: 'Sovuq',
      parentId: parent.body.id,
    }).expect(201);
    const cycle = await send(
      agent,
      'patch',
      `/menu/categories/${parent.body.id}`,
      {
        name: 'Ichimliklar',
        parentId: child.body.id,
      },
    );
    expect(cycle.body.code).toBe('CATEGORY_CYCLE');

    await send(agent, 'post', '/menu/modifier-groups', {
      name: 'Qo‘shimchalar',
      minSelect: 3,
      maxSelect: 1,
      options: [{ name: 'Pishloq', price: 3000 }],
    }).expect(400);
    const group = await send(agent, 'post', '/menu/modifier-groups', {
      name: 'Qo‘shimchalar',
      minSelect: 0,
      maxSelect: 3,
      options: [
        { name: 'Pishloq', price: 3000 },
        { name: 'Jalapeno', price: 2000 },
      ],
    }).expect(201);

    const product = await send(agent, 'post', '/menu/products', {
      categoryId: child.body.id,
      name: 'Kola',
      variants: [{ name: '0.5 L', price: 8000 }],
      modifierGroupIds: [group.body.id],
    }).expect(201);
    await send(agent, 'post', '/menu/products', {
      categoryId: child.body.id,
      name: 'Bo‘sh',
      variants: [{ name: 'X', price: -5 }],
    }).expect(400);
    // Removing every active variant is rejected; removed variants are deactivated.
    const zero = await send(
      agent,
      'patch',
      `/menu/products/${product.body.id}`,
      {
        categoryId: child.body.id,
        name: 'Kola',
        variants: [{ name: '1 L', price: 12000, isActive: false }],
      },
    );
    expect(zero.body.code).toBe('VARIANT_REQUIRED');
    await send(agent, 'delete', `/menu/products/${product.body.id}`).expect(
      204,
    );
    await send(agent, 'delete', `/menu/products/${product.body.id}`).expect(
      404,
    );
  });

  it('isolates menus between tenants', async () => {
    const a = await ownerAgent();
    const b = await ownerAgent();
    const { categoryId, productId } = await seedMenu(a.agent);
    const groupA = await send(a.agent, 'post', '/menu/modifier-groups', {
      name: 'Souslar',
      minSelect: 0,
      maxSelect: 1,
      options: [{ name: 'Ketchup', price: 0 }],
    }).expect(201);
    await send(b.agent, 'post', '/menu/products', {
      categoryId,
      name: 'Steal',
      variants: [{ name: 'X', price: 1 }],
    }).expect(400);
    const bCategory = await send(b.agent, 'post', '/menu/categories', {
      name: 'B',
    }).expect(201);
    await send(b.agent, 'post', '/menu/products', {
      categoryId: bCategory.body.id,
      name: 'Mix',
      variants: [{ name: 'X', price: 1 }],
      modifierGroupIds: [groupA.body.id],
    }).expect(400);
    await send(b.agent, 'patch', `/menu/products/${productId}`, {
      categoryId: bCategory.body.id,
      name: 'Hijack',
      variants: [{ name: 'X', price: 1 }],
    }).expect(404);
    const variant = await ctx.db.productVariant.findFirstOrThrow({
      where: { productId },
    });
    await send(b.agent, 'put', '/menu/branch-prices', {
      branchId: b.tenant.branch.id,
      items: [{ variantId: variant.id, price: 1, isAvailable: true }],
    }).expect(400);
    const bMenu = await b.agent
      .get(`/api/menu?branchId=${b.tenant.branch.id}`)
      .expect(200);
    expect(bMenu.body.products).toHaveLength(0);
    await b.agent.get(`/api/menu?branchId=${a.tenant.branch.id}`).expect(403);
  });
});
