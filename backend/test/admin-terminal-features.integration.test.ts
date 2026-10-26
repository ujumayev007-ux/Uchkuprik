import { afterAll, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { hashSecret } from '../src/lib/crypto.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Product visibility, product pictures, the Excel menu import, unique staff PINs,
// terminal management by the Admin and per-employee work shifts.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);
const raw = (agent: Agent, path: string, bytes: Buffer) =>
  agent
    .post(`/api${path}`)
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function adminWithMenu() {
  const tenant = await createTenant(ctx);
  const admin = ctx.agent();
  await login(admin, tenant.slug, 'owner').expect(200);
  const category = await post(admin, '/menu/categories', { name: 'Fast food' }).expect(201);
  const product = await post(admin, '/menu/products', {
    categoryId: category.body.id,
    name: 'Lavash',
    variants: [{ name: 'Standart', price: 28_000 }],
  }).expect(201);
  return { tenant, admin, categoryId: category.body.id as string, productId: product.body.id as string };
}

const sellingNames = async (agent: Agent) =>
  ((await agent.get('/api/menu').expect(200)).body.products as { name: string }[]).map(
    (product) => product.name,
  );

describe('product visibility', () => {
  it('hides a product from selling menus without deleting it, and shows it again', async () => {
    const { admin, productId } = await adminWithMenu();
    expect(await sellingNames(admin)).toContain('Lavash');
    await patch(admin, `/menu/products/${productId}/visibility`, { isActive: false }).expect(200);
    expect(await sellingNames(admin)).not.toContain('Lavash');
    const all = await admin.get('/api/menu?all=true').expect(200);
    const hidden = all.body.products.find((p: { id: string }) => p.id === productId);
    expect(hidden.isActive).toBe(false);
    expect(await ctx.db.product.count({ where: { id: productId, deletedAt: null } })).toBe(1);
    await patch(admin, `/menu/products/${productId}/visibility`, { isActive: true }).expect(200);
    expect(await sellingNames(admin)).toContain('Lavash');
  });
});

describe('product pictures', () => {
  it('stores an uploaded picture, serves it, keeps https links and refuses other files', async () => {
    const { admin, categoryId, productId } = await adminWithMenu();
    const uploaded = await raw(admin, '/menu/product-images', PNG).expect(201);
    expect(uploaded.body.url).toBe(`/api/menu/images/${uploaded.body.id}`);
    const served = await ctx.agent().get(uploaded.body.url).expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(served.body as Buffer, PNG)).toBe(0);

    await raw(admin, '/menu/product-images', Buffer.from('<svg onload=alert(1)></svg> not an image')).expect(400);

    const body = {
      categoryId,
      name: 'Lavash',
      imageUrl: uploaded.body.url,
      variants: [{ name: 'Standart', price: 28_000 }],
    };
    await patch(admin, `/menu/products/${productId}`, body).expect(200);
    // An https link still works; the replaced upload is deleted.
    await patch(admin, `/menu/products/${productId}`, {
      ...body,
      imageUrl: 'https://example.com/lavash.jpg',
    }).expect(200);
    expect(await ctx.db.productImage.count({ where: { id: uploaded.body.id } })).toBe(0);
    await patch(admin, `/menu/products/${productId}`, {
      ...body,
      imageUrl: 'http://example.com/lavash.jpg',
    }).expect(400);
  });
});

describe('Excel menu import', () => {
  it('checks every row, saves only the good ones after confirmation and never overwrites', async () => {
    const { admin, tenant } = await adminWithMenu();
    const template = await admin
      .get('/api/menu/import/template')
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(template.headers['content-type']).toContain('spreadsheetml');
    // The empty template is read back: header found, no rows.
    const empty = await raw(admin, '/menu/import?mode=preview', template.body as Buffer).expect(200);
    expect(empty.body.rows).toEqual([]);

    const header = [
      'Taom nomi *',
      'Kategoriya *',
      'Sotuv narxi (so‘m) *',
      'Tannarx (so‘m)',
      'O‘lcham / birlik',
      'Tavsif',
      'Artikul (SKU)',
      'Shtrix-kod',
      'Tayyorlash vaqti (daqiqa)',
      'Ko‘rinadi (Ha / Yo‘q)',
    ].map((value) => ({ value, type: String }));
    const row = (values: (string | number)[]) =>
      values.map((value) =>
        typeof value === 'number' ? { value, type: Number } : { value, type: String },
      );
    const file = Buffer.from(
      (await writeXlsxFile(
        [
          header,
          row(['Kola', 'Ichimliklar', 10000, 6000, '0.5 L', '', 'KOLA-1', '', '', 'Ha']),
          row(['Burger', 'Fast food', '35 000', '', '', 'Mol go‘shti', '', '', 12, 'yo‘q']),
          row(['Kola', 'Ichimliklar', 11000, '', '1 L', '', '', '', '', '']),
          row(['Lavash', 'Fast food', 30000, '', '', '', '', '', '', '']),
          row(['Choy', '', 'bepul', '', '', '', '', '', '', 'balki']),
        ] as never,
      ).toBuffer()) as unknown as Uint8Array,
    );
    const preview = await raw(admin, '/menu/import?mode=preview', file).expect(200);
    const byRow = new Map(
      (preview.body.rows as { row: number; errors: string[]; newCategory: boolean; isActive: boolean }[]).map(
        (item) => [item.row, item],
      ),
    );
    expect(byRow.get(2)).toMatchObject({ errors: [], newCategory: true, isActive: true });
    expect(byRow.get(3)).toMatchObject({ errors: [], newCategory: false, isActive: false });
    expect(byRow.get(4)!.errors).toContain('errDupFile');
    expect(byRow.get(5)!.errors).toContain('errDupMenu');
    expect(byRow.get(6)!.errors).toEqual(
      expect.arrayContaining(['errCategory', 'errPrice', 'errVisible']),
    );
    // Preview writes nothing.
    expect(
      await ctx.db.product.count({ where: { tenantId: tenant.tenant.id, deletedAt: null } }),
    ).toBe(1);

    const saved = await raw(admin, '/menu/import?mode=commit', file).expect(200);
    expect(saved.body.created).toBe(2);
    expect(saved.body.rejected).toHaveLength(3);
    const all = await admin.get('/api/menu?all=true').expect(200);
    const burger = all.body.products.find((p: { name: string }) => p.name === 'Burger');
    expect(burger.isActive).toBe(false);
    expect(burger.variants[0].price).toBe(35_000);
    expect(burger.prepTimeMinutes).toBe(12);
    const lavash = all.body.products.find((p: { name: string }) => p.name === 'Lavash');
    expect(lavash.variants[0].price).toBe(28_000);

    // Importing the same file again adds nothing.
    const again = await raw(admin, '/menu/import?mode=commit', file).expect(200);
    expect(again.body.created).toBe(0);

    await raw(admin, '/menu/import?mode=preview', Buffer.from('not a spreadsheet')).expect(400);
  });
});

describe('staff PINs and terminals', () => {
  it('refuses a PIN another active employee already has', async () => {
    const { tenant, admin } = await adminWithMenu();
    const taken = await addUser(ctx, tenant.tenant.id, {
      username: 'anvar',
      roleIds: [tenant.roleId('cashier')],
      pin: '1234',
    });
    const refused = await post(admin, '/users', {
      username: 'nodir',
      displayName: 'Nodir',
      pin: '1234',
      roleIds: [tenant.roleId('waiter')],
      allBranches: true,
      branchIds: [],
    }).expect(409);
    expect(refused.body.code).toBe('PIN_IN_USE');
    const nodir = await post(admin, '/users', {
      username: 'nodir',
      displayName: 'Nodir',
      pin: '2345',
      roleIds: [tenant.roleId('waiter')],
      allBranches: true,
      branchIds: [],
    }).expect(201);
    await post(admin, `/users/${nodir.body.id}/pin`, { pin: '1234' }).expect(409);
    // Setting one's own current PIN again is not a clash.
    await post(admin, `/users/${taken.id}/pin`, { pin: '1234' }).expect(200);
  });

  it('lets the Admin rename a terminal, set its role, choose its employees and switch it off', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = await ctx.db.user.findFirstOrThrow({ where: { tenantId, username: 'owner' } });
    await ctx.db.user.update({
      where: { id: owner.id },
      data: { pinHash: await hashSecret(ctx.services.secrets.pepperPin(owner.id, '9999')) },
    });
    const anvar = await addUser(ctx, tenantId, { username: 'anvar', roleIds: [tenant.roleId('waiter')], pin: '1234' });
    const nodir = await addUser(ctx, tenantId, { username: 'nodir', roleIds: [tenant.roleId('waiter')], pin: '2345' });
    const cook = await addUser(ctx, tenantId, { username: 'oshpaz', roleIds: [tenant.roleId('kitchen')], pin: '3456' });

    const admin = ctx.agent();
    await login(admin, tenant.slug, 'owner').expect(200);
    const terminal = ctx.agent();
    await login(terminal, tenant.slug, 'owner').expect(200);
    const device = await post(terminal, '/devices/register', {
      branchId: tenant.branch.id,
      name: 'Zal planshet',
      panel: 'OTHER',
    }).expect(201);
    await post(terminal, '/auth/logout').expect(204);
    const deviceId = device.body.id ?? device.body.device?.id;
    expect(deviceId).toBeTruthy();
    const staffIds = async () =>
      ((await terminal.get('/api/pin/device').expect(200)).body.staff as { id: string }[]).map((s) => s.id);
    expect(await staffIds()).toEqual(expect.arrayContaining([anvar.id, nodir.id, cook.id]));

    await patch(admin, `/devices/${deviceId}`, {
      name: 'Ofitsiant planshet',
      panel: 'WAITER',
      allowedUserIds: [anvar.id],
    }).expect(200);
    const names = await staffIds();
    expect(names).toContain(anvar.id);
    expect(names).toContain(owner.id);
    expect(names).not.toContain(nodir.id);
    expect(names).not.toContain(cook.id);
    await post(terminal, '/auth/pin', { userId: nodir.id, pin: '2345' }).expect(401);

    // Anvar opens his shift on this terminal; Nodir's own shift is separate.
    await post(terminal, '/auth/pin', { userId: anvar.id, pin: '1234' }).expect(200);
    await post(terminal, '/attendance/clock-in').expect(201);
    await post(terminal, '/attendance/clock-in').expect(409);
    await post(terminal, '/auth/logout').expect(204);
    const open = await ctx.db.attendanceRecord.findFirstOrThrow({
      where: { userId: anvar.id, clockOut: null },
    });
    expect(open.deviceId).toBe(deviceId);
    // Everyone allowed again: Nodir signs in, Anvar's shift stays open.
    await patch(admin, `/devices/${deviceId}`, { allowedUserIds: [] }).expect(200);
    await post(terminal, '/auth/pin', { userId: nodir.id, pin: '2345' }).expect(200);
    await post(terminal, '/attendance/clock-in').expect(201);
    await post(terminal, '/attendance/clock-out').expect(200);
    await post(terminal, '/auth/logout').expect(204);
    expect(
      await ctx.db.attendanceRecord.count({ where: { userId: anvar.id, clockOut: null } }),
    ).toBe(1);

    // Switched off: no staff list and no PIN sign-in until switched on again.
    await patch(admin, `/devices/${deviceId}`, { enabled: false }).expect(200);
    const off = await terminal.get('/api/pin/device').expect(403);
    expect(off.body.code).toBe('DEVICE_DISABLED');
    await patch(admin, `/devices/${deviceId}`, { enabled: true }).expect(200);
    await terminal.get('/api/pin/device').expect(200);

    // A terminal waiting for the Owner can not be changed by the Admin.
    await ctx.db.device.update({ where: { id: deviceId }, data: { status: 'PENDING' } });
    await patch(admin, `/devices/${deviceId}`, { enabled: true }).expect(403);
  });

  it('publishes the kitchen design settings with the standard design by default', async () => {
    const tenant = await createTenant(ctx);
    const admin = ctx.agent();
    await login(admin, tenant.slug, 'owner').expect(200);
    const me = await admin.get('/api/auth/me').expect(200);
    expect(me.body.ordering.kitchen.design).toEqual({
      enabled: true,
      defaultTheme: 'classic',
      whoCanChange: 'all',
    });
  });
});
