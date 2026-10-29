import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Receipt designer: every save keeps the previous state, versions restore, templates
// duplicate, and an order gets an electronic receipt link.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const send = (
  agent: Agent,
  method: 'post' | 'put',
  path: string,
  body: object = {},
) => agent[method](`/api${path}`).set('Origin', ORIGIN).send(body);

describe('receipt template versions', () => {
  it('keeps the previous state on save and restores it', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const created = await send(owner, 'post', '/receipt-templates', {
      name: 'Zal',
      kind: 'CUSTOMER',
      settings: { widthMm: 80, thankYou: 'Birinchi' },
    }).expect(201);
    const id = created.body.id as string;
    await send(owner, 'put', `/receipt-templates/${id}`, {
      name: 'Zal',
      kind: 'CUSTOMER',
      settings: {
        widthMm: 58,
        thankYou: 'Ikkinchi',
        layoutOrder: ['footer', 'items'],
      },
    }).expect(200);
    const list = await owner
      .get(`/api/receipt-templates/${id}/versions`)
      .expect(200);
    expect(list.body.versions).toHaveLength(1);
    expect(list.body.versions[0].settings).toMatchObject({
      widthMm: 80,
      thankYou: 'Birinchi',
    });

    await send(
      owner,
      'post',
      `/receipt-templates/${id}/versions/${list.body.versions[0].id}/restore`,
    ).expect(200);
    const restored = await ctx.db.receiptTemplate.findUniqueOrThrow({
      where: { id },
    });
    expect(restored.settings).toMatchObject({
      widthMm: 80,
      thankYou: 'Birinchi',
    });
    // The replaced state is kept too.
    const after = await owner
      .get(`/api/receipt-templates/${id}/versions`)
      .expect(200);
    expect(after.body.versions).toHaveLength(2);
    expect(after.body.versions[0].settings).toMatchObject({
      widthMm: 58,
      layoutOrder: ['footer', 'items'],
    });
    expect(
      await ctx.db.auditLog.count({
        where: {
          tenantId: tenant.tenant.id,
          action: 'receipt.template.restore',
        },
      }),
    ).toBe(1);

    // Default receipt: history too.
    await send(owner, 'put', '/settings/receipt', {
      widthMm: 80,
      thankYou: 'A',
    }).expect(200);
    await send(owner, 'put', '/settings/receipt', {
      widthMm: 80,
      thankYou: 'B',
    }).expect(200);
    const defaults = await owner
      .get('/api/receipt-templates/default/versions')
      .expect(200);
    expect(defaults.body.versions[0].settings.thankYou).toBe('A');
    await send(
      owner,
      'post',
      `/receipt-templates/default/versions/${defaults.body.versions[0].id}/restore`,
    ).expect(200);
    expect(
      (await owner.get('/api/settings/receipt').expect(200)).body.thankYou,
    ).toBe('A');

    // Duplicate: same settings, no assignments; the name must be free.
    const copy = await send(
      owner,
      'post',
      `/receipt-templates/${id}/duplicate`,
      { name: 'Zal 2' },
    ).expect(201);
    const duplicated = await ctx.db.receiptTemplate.findUniqueOrThrow({
      where: { id: copy.body.id },
    });
    expect(duplicated.settings).toMatchObject({ thankYou: 'Birinchi' });
    await send(owner, 'post', `/receipt-templates/${id}/duplicate`, {
      name: 'Zal 2',
    }).expect(409);

    // Another restaurant cannot see or restore these versions.
    const other = await createTenant(ctx);
    const stranger = ctx.agent();
    await login(stranger, other.slug, 'owner').expect(200);
    expect(
      (await stranger.get(`/api/receipt-templates/${id}/versions`).expect(200))
        .body.versions,
    ).toHaveLength(0);
    await send(
      stranger,
      'post',
      `/receipt-templates/${id}/versions/${list.body.versions[0].id}/restore`,
    ).expect(404);
  });
});

describe('electronic receipt', () => {
  it('gives an order one unguessable public link', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Lavash' },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        name: 'Standart',
        price: 25_000,
      },
    });
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const order = await send(owner, 'post', '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);
    const first = await send(
      owner,
      'post',
      `/orders/${order.body.id}/e-receipt`,
    ).expect(200);
    expect(first.body.path).toMatch(/^\/buyurtma\/[A-Za-z0-9_-]{16,64}$/);
    const again = await send(
      owner,
      'post',
      `/orders/${order.body.id}/e-receipt`,
    ).expect(200);
    expect(again.body.token).toBe(first.body.token);
    const page = await ctx
      .agent()
      .get(`/api/public/orders/${first.body.token}`)
      .expect(200);
    expect(page.body.total).toBe(25_000);
    expect(page.body.items[0].name).toBe('Lavash');

    const other = await createTenant(ctx);
    const stranger = ctx.agent();
    await login(stranger, other.slug, 'owner').expect(200);
    await send(stranger, 'post', `/orders/${order.body.id}/e-receipt`).expect(
      404,
    );
  });
});

describe('templates per customer receipt type', () => {
  it('the bill and the paid receipt use their own templates; kitchen templates cannot', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const make = async (
      name: string,
      kind: 'CUSTOMER' | 'KITCHEN',
      thankYou: string,
    ) =>
      (
        await send(owner, 'post', '/receipt-templates', {
          name,
          kind,
          settings: { thankYou },
        }).expect(201)
      ).body.id as string;
    const bill = await make('Hisob', 'CUSTOMER', 'HISOB SHABLONI');
    const paid = await make('Tolangan', 'CUSTOMER', 'TOLANGAN SHABLONI');
    const kitchen = await make('Oshxona', 'KITCHEN', 'OSHXONA');
    await send(owner, 'put', `/receipt-templates/${bill}/assignments`, {
      targets: [{ type: 'RECEIPT_TYPE', targetId: 'PRELIM_BILL' }],
    }).expect(200);
    await send(owner, 'put', `/receipt-templates/${paid}/assignments`, {
      targets: [{ type: 'RECEIPT_TYPE', targetId: 'PAID' }],
    }).expect(200);
    await send(owner, 'put', `/receipt-templates/${kitchen}/assignments`, {
      targets: [{ type: 'RECEIPT_TYPE', targetId: 'PAID' }],
    }).expect(400);
    await send(owner, 'put', `/receipt-templates/${paid}/assignments`, {
      targets: [{ type: 'RECEIPT_TYPE', targetId: 'SHIFT_REPORT' }],
    }).expect(400);

    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Somsa' },
    });
    const variant = await ctx.db.productVariant.create({
      data: { tenantId, productId: product.id, name: 'Standart', price: 8_000 },
    });
    await send(owner, 'post', '/shifts/open', { openingCash: 0 }).expect(201);
    const order = await send(owner, 'post', '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);
    const before = await owner
      .get(`/api/orders/${order.body.id}/receipt`)
      .expect(200);
    expect(before.body.layout.thankYou).toBe('HISOB SHABLONI');
    await send(owner, 'post', `/orders/${order.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: 'CASH',
      amount: 8_000,
      tendered: 10_000,
    }).expect(201);
    const after = await owner
      .get(`/api/orders/${order.body.id}/receipt`)
      .expect(200);
    expect(after.body.layout.thankYou).toBe('TOLANGAN SHABLONI');
  });
});
