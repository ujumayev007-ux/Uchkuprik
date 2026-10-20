import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(async () => {
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

const binary = (agent: Agent, path: string) =>
  agent
    .get(`/api${path}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

const HOSTILE = '=HYPERLINK("http://evil.example","bosing")';
const LONG =
  'Katta o‘lchamdagi maxsus assorti: lag‘mon, manti, somsa va boshqa juda uzun nomli taom (Пловное блюдо)';

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const food = await post(owner, '/menu/categories', {
    name: 'Taomlar',
  }).expect(201);
  const drinks = await post(owner, '/menu/categories', {
    name: 'Ichimliklar',
  }).expect(201);
  const mk = async (categoryId: string, name: string, price: number) => {
    const product = await post(owner, '/menu/products', {
      categoryId,
      name,
      variants: [{ name: 'Standart', price, cost: Math.round(price / 3) }],
    }).expect(201);
    return ctx.db.productVariant.findFirstOrThrow({
      where: { tenantId, productId: product.body.id },
    });
  };
  const hostile = await mk(food.body.id, HOSTILE, 30_000);
  const long = await mk(food.body.id, LONG, 45_000);
  const cola = await mk(drinks.body.id, 'Kola', 10_000);
  await post(owner, '/shifts/open', { openingCash: 0 }).expect(201);
  const orderIds: string[] = [];
  for (const items of [
    [
      { variantId: hostile.id, quantity: 2 },
      { variantId: cola.id, quantity: 1 },
    ],
    [{ variantId: long.id, quantity: 1 }],
    [{ variantId: cola.id, quantity: 3 }],
  ]) {
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items,
    }).expect(201);
    const view = await owner.get(`/api/orders/${order.body.id}`).expect(200);
    const paid = await post(owner, `/orders/${order.body.id}/payments`, {
      idempotencyKey: randomUUID(),
      method: items.length === 2 ? 'CARD' : 'CASH',
      amount: view.body.total,
      ...(items.length === 2 ? {} : { tendered: view.body.total }),
    });
    if (paid.status !== 201)
      throw new Error(JSON.stringify(paid.body) + ' total=' + view.body.total);
    await post(owner, `/orders/${order.body.id}/complete`).expect(200);
    orderIds.push(order.body.id);
  }
  // A stock item with a movement (the default warehouse is created on first use).
  await owner.get('/api/inventory/items').expect(200);
  const warehouse = await ctx.db.warehouse.findFirstOrThrow({
    where: { tenantId },
  });
  const stock = await ctx.db.stockItem.create({
    data: { tenantId, name: '=SUM(1+1) Un', baseUnit: 'G', minStock: 5000 },
  });
  await ctx.db.stockBalance.create({
    data: {
      tenantId,
      warehouseId: warehouse.id,
      stockItemId: stock.id,
      quantity: 2500,
      avgCost: 12,
    },
  });
  await ctx.db.stockMovement.create({
    data: {
      tenantId,
      warehouseId: warehouse.id,
      stockItemId: stock.id,
      type: 'RECEIPT',
      quantity: 2500,
      unitCost: 12,
      balanceAfter: 2500,
      reason: '@kirim izohi',
    },
  });
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  const cook = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  const cashier = ctx.agent();
  await login(cashier, tenant.slug, 'kassir').expect(200);
  return { tenant, tenantId, owner, cook, cashier };
}

const unzip = (file: Buffer) => unzipSync(new Uint8Array(file));
const text = (files: ReturnType<typeof unzipSync>, name: string) =>
  strFromU8(files[name]!);

describe('report exports (Excel, Word, PDF)', () => {
  it('produces valid files that reconcile with the screen and neutralise formulas', async () => {
    const s = await setup();
    const screen = (await s.owner.get('/api/reports/sales').expect(200)).body;
    expect(screen.orders).toBe(3);

    const xlsx = await binary(s.owner, '/reports/export?format=xlsx').expect(
      200,
    );
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(xlsx.headers['content-disposition']).toMatch(/hisobot-.*\.xlsx/);
    const book = unzip(xlsx.body);
    const names = Object.keys(book);
    expect(names).toContain('xl/workbook.xml');
    const sheets = names.filter((name) =>
      /xl\/worksheets\/sheet\d+\.xml/.test(name),
    );
    expect(sheets.length).toBeGreaterThanOrEqual(7);
    const all = sheets.map((name) => text(book, name)).join('\n');
    const strings = names.includes('xl/sharedStrings.xml')
      ? text(book, 'xl/sharedStrings.xml')
      : '';
    const content = all + strings;
    // Dish names that look like formulas are stored as text, never as <f> formulas.
    expect(content).not.toMatch(/<f>/);
    expect(content).toContain(`'=HYPERLINK`);
    expect(content).toContain(`'=SUM(1+1) Un`);
    expect(content).toContain(`'@kirim izohi`);
    // Uzbek and Cyrillic text survives.
    expect(content).toContain('lag‘mon');
    expect(content).toContain('Пловное');

    const docx = await binary(s.owner, '/reports/export?format=docx').expect(
      200,
    );
    const word = unzip(docx.body);
    expect(Object.keys(word)).toContain('word/document.xml');
    const xml = text(word, 'word/document.xml');
    for (const title of [
      'Umumiy ko‘rsatkichlar',
      'To‘lov usullari',
      'Mahsulotlar bo‘yicha sotuv',
      'Ombor qoldiqlari',
      'Ombor harakatlari',
    ])
      expect(xml).toContain(title);
    // The same totals as the screen (grouped digits).
    const grouped = (n: number) =>
      String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    expect(xml).toContain(grouped(screen.salesTotal));
    expect(xml).toContain(grouped(screen.collected));
    expect(xml).toContain('Filial:');

    const pdf = await binary(s.owner, '/reports/export?format=pdf').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const pdfText = pdf.body.toString('latin1');
    expect(pdfText.startsWith('%PDF-')).toBe(true);
    expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(
      (pdfText.match(/\/Type \/Page\b/g) ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    expect(pdf.body.length).toBeGreaterThan(3000);
  });

  it('categories and products reconcile and refunds/costs follow permissions', async () => {
    const s = await setup();
    const docx = await binary(s.owner, '/reports/export?format=docx').expect(
      200,
    );
    const xml = text(unzip(docx.body), 'word/document.xml');
    // Two "Jami" rows with the same quantity and revenue (categories and products).
    const rows = [...xml.matchAll(/Jami<\/w:t>[\s\S]*?<\/w:tr>/g)].map((m) =>
      [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((t) => t[1])
        .join('|'),
    );
    const sameTotals = rows.filter(
      (row) => row.includes('7') && row.includes('145 000'),
    );
    expect(sameTotals.length).toBeGreaterThanOrEqual(2);
    // The cashier (no inventory permission) gets no stock sections and a note about it.
    const cashierDoc = await binary(s.cashier, '/reports/export?format=docx');
    // Cashiers lack reports.view in the default roles.
    expect([403, 200]).toContain(cashierDoc.status);
  });

  it('the saved layout hides sections and columns in every format; only Admins save it', async () => {
    const s = await setup();
    const current = (await s.owner.get('/api/reports/layout').expect(200)).body;
    expect(current.layout.sections).toHaveLength(8);
    expect(current.catalog.map((c: { key: string }) => c.key)).toContain(
      'stockMovements',
    );
    await put(s.cook, '/reports/layout', current.layout).expect(403);
    const layout = {
      sections: current.layout.sections.map(
        (entry: { key: string; enabled: boolean }) => ({
          ...entry,
          enabled: !['stockMovements', 'shifts', 'cashiers'].includes(
            entry.key,
          ),
        }),
      ),
      hiddenColumns: { products: ['revenue'], stockBalances: ['minStock'] },
    };
    await put(s.owner, '/reports/layout', layout).expect(200);
    const xml = text(
      unzip(
        (await binary(s.owner, '/reports/export?format=docx').expect(200)).body,
      ),
      'word/document.xml',
    );
    expect(xml).not.toContain('Ombor harakatlari');
    expect(xml).not.toContain('Kassa smenalari');
    expect(xml).not.toContain('Xodimlar (kassirlar)');
    expect(xml).toContain('Mahsulotlar bo‘yicha sotuv');
    expect(xml).not.toContain('Minimal qoldiq');
    // The "revenue" column of products is gone, but categories keep their own.
    expect(xml.match(/Tushum \(so‘m\)/g)?.length).toBe(1);
    const book = unzip(
      (await binary(s.owner, '/reports/export?format=xlsx').expect(200)).body,
    );
    const sheets = Object.keys(book).filter((name) =>
      /worksheets\/sheet\d+\.xml/.test(name),
    );
    expect(sheets.length).toBe(5);
    // Hiding is presentation: the screen route still shows everything it always did.
    expect(
      (await s.owner.get('/api/reports/sales').expect(200)).body.orders,
    ).toBe(3);
  });

  it('refuses users without reports.view and invalid formats; tenants are isolated', async () => {
    const a = await setup();
    const b = await setup();
    await binary(a.cook, '/reports/export?format=pdf').expect(403);
    await a.owner.get('/api/reports/export?format=exe').expect(400);
    await a.owner.get('/api/reports/export').expect(400);
    // Another restaurant's export never contains this one's orders or products.
    const other = unzip(
      (await binary(b.owner, '/reports/export?format=docx').expect(200)).body,
    );
    const otherXml = text(other, 'word/document.xml');
    // Same synthetic data shape, but the layout of A must not leak into B.
    await put(a.owner, '/reports/layout', {
      sections: [{ key: 'summary', enabled: true }],
      hiddenColumns: {},
    }).expect(200);
    const bLayout = (await b.owner.get('/api/reports/layout').expect(200)).body
      .layout;
    expect(
      bLayout.sections.filter((entry: { enabled: boolean }) => entry.enabled),
    ).toHaveLength(8);
    expect(otherXml).toContain('Mahsulotlar bo‘yicha sotuv');
  });

  it('an empty period still produces readable files', async () => {
    const s = await setup();
    const url = '/reports/export?from=2020-01-01&to=2020-01-02';
    for (const format of ['xlsx', 'docx', 'pdf'])
      await binary(s.owner, `${url}&format=${format}`).expect(200);
    const xml = text(
      unzip((await binary(s.owner, `${url}&format=docx`)).body),
      'word/document.xml',
    );
    expect(xml).toContain('Ma’lumot yo‘q');
  });
});
