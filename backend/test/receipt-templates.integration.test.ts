import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  columnsForWidth,
  receiptTemplateSchema,
} from '../src/printing/receipt-template.js';
import { receiptTicket, sampleReceipt } from '../src/printing/receipt.js';
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

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const call = (
  agent: Agent,
  method: 'post' | 'put' | 'delete',
  path: string,
  body: object = {},
) => agent[method](`/api${path}`).set('Origin', ORIGIN).send(body);

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const settings = (extra: object = {}) =>
  receiptTemplateSchema.parse({ ...extra });

describe('receipt layout engine', () => {
  it('derives characters per line from the paper width, including custom widths', () => {
    expect(columnsForWidth(58)).toBe(32);
    expect(columnsForWidth(80)).toBe(48);
    expect(columnsForWidth(72)).toBe(42);
    expect(columnsForWidth(80, 6)).toBe(44);
    expect(columnsForWidth(40)).toBeGreaterThanOrEqual(16);
  });

  it('applies margins, hides fields and follows the length mode', () => {
    const full = receiptTicket(sampleReceipt(), settings());
    expect(text(full)).toContain('JAMI');
    expect(text(full)).toContain('Stol 4');
    expect(text(full)).toContain('Kassir: Dilnoza');
    const hidden = receiptTicket(
      sampleReceipt(),
      settings({ showTable: false, showCashier: false, showPayments: false }),
    );
    expect(text(hidden)).not.toContain('Stol 4');
    expect(text(hidden)).not.toContain('Kassir');
    expect(text(hidden)).not.toContain('Naqd');
    // Margins are sent to the printer: GS L (left) and GS W (width).
    const wide = settings({ marginLeftMm: 5, marginRightMm: 5 });
    const bytes = Array.from(receiptTicket(sampleReceipt(), wide));
    const at = bytes.findIndex(
      (byte, index) => byte === 0x1d && bytes[index + 1] === 0x4c,
    );
    expect(at).toBeGreaterThan(-1);
    expect(bytes[at + 2]).toBe(40); // 5 mm = 40 dots
    // A fixed length pads the paper; the automatic length does not.
    const auto = receiptTicket(sampleReceipt(), settings());
    const fixed = receiptTicket(
      sampleReceipt(),
      settings({ lengthMode: 'fixed', fixedLengthMm: 400 }),
    );
    expect(fixed.length).toBeGreaterThan(auto.length);
    // A 58 mm printer wraps to 32 columns.
    const narrow = text(
      receiptTicket(sampleReceipt(), settings({ widthMm: 58 })),
    );
    for (const line of narrow.split('\n'))
      expect(line.replace(/[^\x20-\x7e]/g, '').length).toBeLessThanOrEqual(40);
  });

  it('prints the logo as a 1-bit picture with the chosen alignment, never a clipped one', () => {
    const w = 128;
    const h = 16;
    const data = Buffer.alloc((w >> 3) * h, 0xff).toString('base64');
    const find = (bytes: number[], ...pattern: number[]) =>
      bytes.findIndex((_byte, index) =>
        pattern.every((value, offset) => bytes[index + offset] === value),
      );
    const withLogo = Array.from(
      receiptTicket(
        sampleReceipt(),
        settings({
          showLogo: true,
          logoAlign: 'right',
          logoRaster: { w, h, data },
        }),
      ),
    );
    // ESC a 2 (right) then GS v 0 with 16 bytes per row and 16 rows.
    const at = find(
      withLogo,
      0x1b,
      0x61,
      0x02,
      0x1d,
      0x76,
      0x30,
      0,
      16,
      0,
      16,
      0,
    );
    expect(at).toBeGreaterThan(-1);
    expect(withLogo.slice(at + 11, at + 11 + 4)).toEqual([255, 255, 255, 255]);
    // Hidden logo or a picture wider than the paper prints nothing extra.
    const off = Array.from(
      receiptTicket(sampleReceipt(), settings({ logoRaster: { w, h, data } })),
    );
    expect(find(off, 0x1d, 0x76, 0x30)).toBe(-1);
    const tooWide = Array.from(
      receiptTicket(
        sampleReceipt(),
        settings({
          widthMm: 58,
          showLogo: true,
          logoRaster: {
            w: 512,
            h: 2,
            data: Buffer.alloc(64 * 2).toString('base64'),
          },
        }),
      ),
    );
    expect(find(tooWide, 0x1d, 0x76, 0x30)).toBe(-1);
  });
});

async function setup(features: Record<string, unknown> = {}) {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const station = await ctx.db.kitchenStation.create({
    data: { tenantId, name: unique('Grill') },
  });
  const printer = (kind: 'RECEIPT' | 'KITCHEN', name: string, extra = {}) =>
    ctx.db.printer.create({
      data: {
        tenantId,
        branchId: branch.id,
        name,
        kind,
        host: '192.168.1.50',
        ...extra,
      },
    });
  const receiptPrinter = await printer('RECEIPT', 'Kassa printeri', {
    paperWidth: 58,
  });
  const kitchenPrinter = await printer('KITCHEN', 'Grill printeri', {
    stationId: station.id,
  });
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
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
  return {
    tenant,
    tenantId,
    branch,
    station,
    receiptPrinter,
    kitchenPrinter,
    owner,
    cashier,
  };
}

describe('named receipt templates', () => {
  it('creates, edits and assigns templates; printer beats department beats type beats default', async () => {
    const s = await setup();
    const create = (name: string, widthMm: number, kind = 'CUSTOMER') =>
      call(s.owner, 'post', '/receipt-templates', {
        name,
        kind,
        settings: settings({ widthMm, title: name }),
      });
    const small = (await create('58 mm chek', 58).then((r) => r.body))
      .id as string;
    const wide = (await create('80 mm chek', 80).then((r) => r.body))
      .id as string;
    const custom = (await create('72 mm maxsus', 72).then((r) => r.body))
      .id as string;
    // Duplicate names are refused.
    expect((await create('58 mm chek', 58)).status).toBe(409);

    const resolve = async (query: string) =>
      (await s.owner.get(`/api/receipt-templates/resolve?${query}`).expect(200))
        .body;
    // Nothing assigned: the restaurant's original layout (80 mm default).
    expect((await resolve('kind=CUSTOMER')).source).toBe('DEFAULT');

    await call(s.owner, 'put', `/receipt-templates/${wide}/assignments`, {
      targets: [{ type: 'TYPE', targetId: 'CUSTOMER' }],
    }).expect(200);
    await call(s.owner, 'put', `/receipt-templates/${small}/assignments`, {
      targets: [{ type: 'PRINTER', targetId: s.receiptPrinter.id }],
    }).expect(200);
    await call(s.owner, 'put', `/receipt-templates/${custom}/assignments`, {
      targets: [{ type: 'STATION', targetId: s.station.id }],
    }).expect(200);

    const byType = await resolve('kind=CUSTOMER');
    expect(byType.source).toBe('TYPE');
    expect(byType.settings.widthMm).toBe(80);
    const byPrinter = await resolve(
      `kind=CUSTOMER&printerId=${s.receiptPrinter.id}`,
    );
    expect(byPrinter.source).toBe('PRINTER');
    expect(byPrinter.settings.widthMm).toBe(58);
    const byStation = await resolve(`kind=CUSTOMER&stationId=${s.station.id}`);
    expect(byStation.source).toBe('STATION');
    expect(byStation.settings.widthMm).toBe(72);
    // The printer wins over its department.
    const both = await resolve(
      `kind=CUSTOMER&printerId=${s.receiptPrinter.id}&stationId=${s.station.id}`,
    );
    expect(both.settings.widthMm).toBe(58);

    // Edit and delete.
    await call(s.owner, 'put', `/receipt-templates/${small}`, {
      name: '58 mm chek',
      kind: 'CUSTOMER',
      settings: settings({ widthMm: 58, fontSize: 'large' }),
    }).expect(200);
    expect(
      (await resolve(`kind=CUSTOMER&printerId=${s.receiptPrinter.id}`)).settings
        .fontSize,
    ).toBe('large');
    await call(s.owner, 'delete', `/receipt-templates/${custom}`).expect(200);
    expect(
      (await resolve(`kind=CUSTOMER&stationId=${s.station.id}`)).source,
    ).toBe('TYPE');
    // Every change is in the audit log.
    const actions = (
      await ctx.db.auditLog.findMany({ where: { tenantId: s.tenantId } })
    ).map((row) => row.action);
    for (const action of [
      'receipt.template.create',
      'receipt.template.update',
      'receipt.template.assign',
      'receipt.template.delete',
    ])
      expect(actions).toContain(action);
  });

  it('is limited to the restaurant: foreign printers, cashiers and other tenants', async () => {
    const a = await setup();
    const b = await setup();
    const id = (
      await call(a.owner, 'post', '/receipt-templates', {
        name: 'A shablon',
        kind: 'CUSTOMER',
        settings: settings(),
      })
    ).body.id as string;
    // A printer of another restaurant cannot be targeted.
    expect(
      (
        await call(a.owner, 'put', `/receipt-templates/${id}/assignments`, {
          targets: [{ type: 'PRINTER', targetId: b.receiptPrinter.id }],
        })
      ).status,
    ).toBe(400);
    // Other restaurants cannot see, change or delete it.
    expect(
      (await b.owner.get('/api/receipt-templates').expect(200)).body.templates,
    ).toHaveLength(0);
    expect(
      (await call(b.owner, 'delete', `/receipt-templates/${id}`)).status,
    ).toBe(404);
    expect(
      (
        await call(b.owner, 'put', `/receipt-templates/${id}`, {
          name: 'x',
          kind: 'CUSTOMER',
          settings: settings(),
        })
      ).status,
    ).toBe(404);
    // Cashiers cannot manage templates.
    expect(
      (
        await call(a.cashier, 'post', '/receipt-templates', {
          name: 'x',
          kind: 'CUSTOMER',
          settings: settings(),
        })
      ).status,
    ).toBe(403);
  });

  it('prints a test page and a real receipt with the printer’s template', async () => {
    const s = await setup();
    const id = (
      await call(s.owner, 'post', '/receipt-templates', {
        name: '58 mm',
        kind: 'CUSTOMER',
        settings: settings({
          widthMm: 58,
          showTable: false,
          title: 'KICHIK CHEK',
        }),
      })
    ).body.id as string;
    await call(s.owner, 'put', `/receipt-templates/${id}/assignments`, {
      targets: [{ type: 'PRINTER', targetId: s.receiptPrinter.id }],
    }).expect(200);

    const test = await call(s.owner, 'post', '/receipt-templates/test-print', {
      printerId: s.receiptPrinter.id,
      kind: 'CUSTOMER',
      settings: settings({ widthMm: 58, title: 'SINOV' }),
    }).expect(201);
    const testJob = await ctx.db.printJob.findUniqueOrThrow({
      where: { id: test.body.jobId },
    });
    expect(text(testJob.payload)).toContain('SINOV');
    expect(testJob.purpose).toBe('TEST');

    // A real order printed on that printer uses the assigned template.
    const category = await ctx.db.menuCategory.create({
      data: { tenantId: s.tenantId, name: 'Taom' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId: s.tenantId, categoryId: category.id, name: 'Lavash' },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId: s.tenantId,
        productId: product.id,
        name: 'Oddiy',
        price: 30_000,
      },
    });
    const room = await ctx.db.room.create({
      data: { tenantId: s.tenantId, branchId: s.branch.id, name: 'Zal' },
    });
    const table = await ctx.db.diningTable.create({
      data: {
        tenantId: s.tenantId,
        branchId: s.branch.id,
        roomId: room.id,
        name: '7-stol',
        qrToken: unique('qr'),
      },
    });
    const order = await call(s.owner, 'post', '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DINE_IN',
      tableId: table.id,
      place: true,
      items: [{ variantId: variant.id, quantity: 2 }],
    }).expect(201);
    const printers = (await s.cashier.get('/api/receipt-printers').expect(200))
      .body.printers;
    expect(printers.map((p: { id: string }) => p.id)).toEqual([
      s.receiptPrinter.id,
    ]);
    const data = (
      await s.cashier
        .get(
          `/api/orders/${order.body.id}/receipt?printerId=${s.receiptPrinter.id}`,
        )
        .expect(200)
    ).body;
    expect(data.layout.widthMm).toBe(58);
    expect(data.layout.title).toBe('KICHIK CHEK');
    const printed = await call(
      s.cashier,
      'post',
      `/orders/${order.body.id}/receipt/print`,
      {
        printerId: s.receiptPrinter.id,
      },
    ).expect(201);
    const job = await ctx.db.printJob.findUniqueOrThrow({
      where: { id: printed.body.jobId },
    });
    const out = text(job.payload);
    expect(out).toContain('KICHIK CHEK');
    expect(out).toContain('Lavash');
    expect(out).not.toContain('7-stol');
    expect(job.orderId).toBe(order.body.id);
  });

  it('can be switched off for the restaurant by the Owner', async () => {
    const s = await setup({ 'receipts.design': { mode: 'OFF' } });
    const response = await s.owner.get('/api/receipt-templates');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FEATURE_DISABLED');
  });
});
