import { strFromU8, unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Ombor export (Excel, Word, PDF): chosen sections and columns, name and status filters,
// purchases and low stock, permissions and tenant isolation.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const binary = (agent: Agent, path: string) =>
  agent
    .get(`/api${path}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
const today = new Date().toISOString().slice(0, 10);
const sheetText = (file: Buffer) => {
  const zip = unzipSync(new Uint8Array(file));
  return Object.entries(zip)
    .filter(([name]) => name.endsWith('.xml'))
    .map(([, data]) => strFromU8(data))
    .join('\n');
};

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const item = async (name: string, minStock: string) =>
    (
      await post(owner, '/inventory/items', {
        name,
        baseUnit: 'G',
        minStock,
      }).expect(201)
    ).body.id as string;
  const flour = await item('Un', '5000');
  const rice = await item('Guruch', '1000');
  const oil = await item('Yog‘', '500');
  const supplier = (
    await post(owner, '/suppliers', { name: 'Toshkent Ulgurji' }).expect(201)
  ).body.id as string;
  const purchase = (
    await post(owner, '/purchases', {
      supplierId: supplier,
      invoiceNo: 'INV-77',
      lines: [
        { stockItemId: flour, quantity: '2000', unitName: 'g', unitPrice: 10 },
        { stockItemId: rice, quantity: '3000', unitName: 'g', unitPrice: 20 },
      ],
    }).expect(201)
  ).body.id as string;
  await post(owner, `/purchases/${purchase}/receive`).expect(200);
  return { tenant, owner, oil };
}

describe('Ombor export', () => {
  it('exports the chosen sections, columns and filters in all three formats', async () => {
    const { tenant, owner } = await setup();
    const base = `/inventory/export?from=${today}&to=${today}`;
    const xlsx = await binary(
      owner,
      `${base}&format=xlsx&sections=stockBalances,stockLowStock,stockPurchases,stockMovements&hidden=stockBalances.minStock`,
    ).expect(200);
    expect(xlsx.headers['content-disposition']).toMatch(/ombor-.*\.xlsx/);
    const text = sheetText(xlsx.body as Buffer);
    expect(text).toContain('Ombor hisoboti');
    expect(text).toContain(tenant.tenant.name);
    expect(text).toContain('Ombor qoldiqlari');
    expect(text).toContain('Kam qolgan va tugagan mahsulotlar');
    expect(text).toContain('Xaridlar');
    expect(text).toContain('Toshkent Ulgurji');
    expect(text).toContain('INV-77');
    expect(text).toContain('Ombor harakatlari');
    // 2000 g × 10 + 3000 g × 20 = 80 000 so‘m (balances value and purchases total).
    expect(text).toMatch(/>80000</);
    // A hidden column is left out of that section only.
    const balancesOnly = sheetText(
      (
        await binary(
          owner,
          `${base}&format=xlsx&sections=stockBalances&hidden=stockBalances.minStock`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(balancesOnly).not.toContain('Minimal qoldiq');
    expect(balancesOnly).toContain('Qiymati (so‘m)');

    // Name filter and status filter.
    const flourOnly = sheetText(
      (
        await binary(
          owner,
          `${base}&format=xlsx&sections=stockBalances&q=un`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(flourOnly).toContain('Qidiruv: un');
    expect(flourOnly).not.toContain('Guruch');
    const out = sheetText(
      (
        await binary(
          owner,
          `${base}&format=xlsx&sections=stockLowStock&status=out`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(out).toContain('Yog‘');
    expect(out).not.toContain('>Un<');

    for (const format of ['docx', 'pdf'] as const) {
      const file = await binary(
        owner,
        `${base}&format=${format}&sections=stockBalances,stockPurchases`,
      ).expect(200);
      expect((file.body as Buffer).length).toBeGreaterThan(1500);
    }
    await owner.get(`/api${base}&format=xlsx&sections=summary`).expect(400);
  });

  it('respects permissions and keeps other restaurants out', async () => {
    const { tenant, owner } = await setup();
    const other = await createTenant(ctx);
    const otherOwner = ctx.agent();
    await login(otherOwner, other.slug, 'owner').expect(200);
    const otherFile = sheetText(
      (
        await binary(
          otherOwner,
          `/inventory/export?format=xlsx&sections=stockBalances,stockPurchases`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(otherFile).not.toContain('Toshkent Ulgurji');
    expect(otherFile).not.toContain('Guruch');

    // A cashier has no inventory.view at all.
    await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    await cashier
      .get('/api/inventory/export?format=xlsx&sections=stockBalances')
      .expect(403);

    // A view-only role: stock without purchases or cost values.
    const viewer = await ctx.db.role.create({
      data: {
        tenantId: tenant.tenant.id,
        name: 'Ombor kuzatuvchi',
        permissions: ['inventory.view'],
      },
    });
    await addUser(ctx, tenant.tenant.id, {
      username: 'kuzatuvchi',
      roleIds: [viewer.id],
    });
    const keeper = ctx.agent();
    await login(keeper, tenant.slug, 'kuzatuvchi').expect(200);
    const file = sheetText(
      (
        await binary(
          keeper,
          `/inventory/export?format=xlsx&sections=stockBalances,stockPurchases`,
        ).expect(200)
      ).body as Buffer,
    );
    expect(file).toContain('Guruch');
    expect(file).not.toContain('Toshkent Ulgurji');
    expect(file).not.toContain('Qiymati (so‘m)');
    expect(file).toContain('Ruxsat yo‘qligi sababli ko‘rsatilmagan bo‘limlar');
    // Only a forbidden section: a file with the note, not a server error.
    for (const format of ['xlsx', 'docx', 'pdf'] as const)
      await binary(
        keeper,
        `/inventory/export?format=${format}&sections=stockPurchases`,
      ).expect(200);
    void owner;
  });
});
