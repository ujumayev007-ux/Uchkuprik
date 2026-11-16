import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPin, verifyPin, clearPinKeyCache } from '../src/lib/pin.js';
import {
  generateIdentity,
  generateLicenseKey,
} from '../src/modules/control/keys.js';
import { createControlRuntime } from '../src/modules/control/runtime.js';
import { clearPolicyCache } from '../src/modules/control/view.js';
import { clearLicenseCache } from '../src/modules/license/license.js';
import { nextOrderNumber } from '../src/modules/orders/engine.js';
import { clearTableCache } from '../src/modules/replication/tables.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
} from './helpers.js';

/**
 * Two real servers, each with its own database and server key: the central server
 * ("hub", REPLICATION_HUB_URL) and a restaurant's Kassa server ("spoke",
 * REPLICATION_SPOKE_URL). Both databases must be migrated; the suite is skipped
 * without them.
 */
const HUB_URL = process.env.REPLICATION_HUB_URL;
const SPOKE_URL = process.env.REPLICATION_SPOKE_URL;
const enabled = !!HUB_URL && !!SPOKE_URL;

const server = generateIdentity();
const key = () => randomBytes(32).toString('base64');

describe.skipIf(!enabled)('two-way replication (Kassa <-> centre)', () => {
  const hub = createTestContext({
    databaseUrl: HUB_URL,
    secretKey: key(),
    control: {
      plane: true,
      signingKeyPem: server.privateKeyPem,
      trustedKeys: [server.publicKey],
    },
  });
  const spoke = createTestContext({
    databaseUrl: SPOKE_URL,
    secretKey: key(),
    selfHosted: true,
    control: {
      plane: false,
      trustedKeys: [server.publicKey],
      url: 'https://central.test',
    },
  });
  // The Kassa's internet: down = no answer; lose = the centre did the work but the
  // answer never arrived (the Kassa must send again without duplicates).
  const network = { down: false, lose: false };
  const transport = (async (url: string | URL, init?: RequestInit) => {
    if (network.down) throw new TypeError('network down');
    const path = new URL(String(url)).pathname;
    const response = await request(hub.app)
      .post(path)
      .send(JSON.parse(String(init?.body ?? '{}')));
    if (network.lose) throw new TypeError('answer lost');
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const runtime = createControlRuntime(spoke.services, { transport });
  spoke.services.controlRuntime = runtime;
  spoke.services.controlView = runtime.view;
  spoke.services.installId = 'FF-REPL-0001-0001';
  spoke.services.appVersion = '1.16.0';

  let tenantId = '';
  let slug = '';
  let customerId = '';
  let stockItemId = '';
  let kassaAdmin: ReturnType<typeof spoke.agent>;
  let centreAdmin: ReturnType<typeof hub.agent>;

  const sync = async () => {
    const result = await runtime.replicate();
    expect(result.error).toBeUndefined();
    return result;
  };
  const balanceOn = async (ctx: typeof hub) =>
    String(
      (
        await ctx.db.stockBalance.findFirstOrThrow({
          where: { tenantId, stockItemId },
        })
      ).quantity,
    );

  beforeAll(async () => {
    clearTableCache();
    clearLicenseCache();
    clearPolicyCache();
    await spoke.db.controlLink.deleteMany({});
    // Licence on the centre, activated by the Kassa server.
    const licenseKey = generateLicenseKey();
    const customer = await hub.db.controlCustomer.create({
      data: { name: unique('Restoran') },
    });
    customerId = customer.id;
    await hub.db.controlLicense.create({
      data: {
        customerId,
        keyHash: hub.services.secrets.keyedHash('license-key', licenseKey),
        keyHint: licenseKey.slice(-5),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        maxInstalls: 5,
        features: [],
      },
    });
    await hub.db.controlPolicy.create({
      data: { customerId, offlineEnabled: true, maxOfflineMinutes: 600 },
    });
    // The Kassa's restaurant with real data (staff, Bozorlik stock).
    const tenant = await createTenant(spoke);
    tenantId = tenant.tenant.id;
    slug = tenant.slug;
    await addUser(spoke, tenantId, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
      pin: '4821',
    });
    await runtime.activate({
      licenseKey,
      deviceName: 'Kassa',
      serverUrl: 'https://central.test',
    });
    expect(await runtime.link()).not.toBeNull();
    kassaAdmin = spoke.agent();
    await login(kassaAdmin, slug, 'owner').expect(200);
    const item = await kassaAdmin
      .post('/api/inventory/items')
      .set('Origin', ORIGIN)
      .send({ name: 'Go‘sht', baseUnit: 'G', minStock: 0 })
      .expect(201);
    stockItemId = item.body.id;
    await kassaAdmin
      .post('/api/purchases/market')
      .set('Origin', ORIGIN)
      .send({
        supplierName: 'Chorsu',
        paid: true,
        paymentMethod: 'CARD',
        lines: [
          { stockItemId, quantity: '10', unitName: 'kg', lineTotal: 900000 },
        ],
      })
      .expect(201);
  });

  afterAll(async () => {
    await spoke.close();
    await hub.close();
  });

  it('copies the whole restaurant to the centre once attached', async () => {
    const attach = await kassaAdmin
      .post('/api/replication/attach')
      .set('Origin', ORIGIN)
      .send({})
      .expect(201);
    expect(attach.body.queued).toBeGreaterThan(10);
    await sync();
    expect(
      await hub.db.tenant.findUnique({ where: { id: tenantId } }),
    ).not.toBeNull();
    expect(await hub.db.user.count({ where: { tenantId } })).toBe(
      await spoke.db.user.count({ where: { tenantId } }),
    );
    expect(await balanceOn(hub)).toBe('10000');
    expect(await hub.db.stockMovement.count({ where: { tenantId } })).toBe(
      await spoke.db.stockMovement.count({ where: { tenantId } }),
    );
    expect(
      await hub.db.expense.count({ where: { tenantId, category: 'Bozorlik' } }),
    ).toBe(1);
    // Nothing was refused or left waiting.
    expect(
      await hub.db.replicationConflict.count({ where: { tenantId } }),
    ).toBe(0);
    expect(await hub.db.replicationParked.count({ where: { tenantId } })).toBe(
      0,
    );
  });

  it('Admin works on the centre while the Kassa is off; the Kassa gets it later', async () => {
    network.down = true; // the Kassa server is unreachable / switched off
    centreAdmin = hub.agent();
    await login(centreAdmin, slug, 'owner').expect(200);
    const items = await centreAdmin.get('/api/inventory/items').expect(200);
    expect(
      items.body.items.find((i: { id: string }) => i.id === stockItemId),
    ).toMatchObject({ quantity: '10000' });
    // Bozorlik on the centre: +2 kg; a new supplier and a new stock item.
    await centreAdmin
      .post('/api/purchases/market')
      .set('Origin', ORIGIN)
      .send({
        supplierName: 'Ulgurji',
        paid: true,
        paymentMethod: 'CARD',
        lines: [
          { stockItemId, quantity: '2', unitName: 'kg', lineTotal: 180000 },
          {
            newItem: { name: 'Piyoz', baseUnit: 'G' },
            quantity: '5',
            unitName: 'kg',
            lineTotal: 40000,
          },
        ],
      })
      .expect(201);
    expect(await balanceOn(hub)).toBe('12000');
    // Meanwhile the Kassa (offline) counts the stock: -1 kg spoilage.
    await kassaAdmin
      .post('/api/inventory/stocktakes')
      .set('Origin', ORIGIN)
      .send({
        counts: [{ stockItemId, counted: '9000' }],
        reason: 'Buzilgan',
      })
      .expect(201);
    expect(await balanceOn(spoke)).toBe('9000');
    expect((await runtime.replicate()).error).toBeDefined(); // offline: queued
    const queued = await spoke.db.replicationChange.count({
      where: {
        tenantId,
        seq: {
          gt: (
            await spoke.db.replicationTenant.findUniqueOrThrow({
              where: { tenantId },
            })
          ).pushedSeq,
        },
      },
    });
    expect(queued).toBeGreaterThan(0);

    network.down = false; // back online
    await sync();
    // Both sides: 10 kg - 1 kg (Kassa) + 2 kg (centre) = 11 kg — nothing lost.
    expect(await balanceOn(spoke)).toBe('11000');
    expect(await balanceOn(hub)).toBe('11000');
    expect(
      await spoke.db.stockItem.count({ where: { tenantId, name: 'Piyoz' } }),
    ).toBe(1);
    expect(
      await spoke.db.supplier.count({ where: { tenantId, name: 'Ulgurji' } }),
    ).toBe(1);
    expect(
      await spoke.db.expense.count({
        where: { tenantId, category: 'Bozorlik' },
      }),
    ).toBe(2);
  });

  it('a lost answer is sent again without duplicates', async () => {
    await kassaAdmin
      .post('/api/purchases/market')
      .set('Origin', ORIGIN)
      .send({
        supplierName: 'Chorsu',
        paid: true,
        paymentMethod: 'CARD',
        lines: [
          { stockItemId, quantity: '1', unitName: 'kg', lineTotal: 90000 },
        ],
      })
      .expect(201);
    network.lose = true; // the centre applies it, the Kassa never hears back
    expect((await runtime.replicate()).error).toBeDefined();
    network.lose = false;
    await sync(); // sent again
    expect(await balanceOn(hub)).toBe('12000');
    expect(await balanceOn(spoke)).toBe('12000');
    expect(await hub.db.stockMovement.count({ where: { tenantId } })).toBe(
      await spoke.db.stockMovement.count({ where: { tenantId } }),
    );
    expect(
      await hub.db.expense.count({ where: { tenantId, category: 'Bozorlik' } }),
    ).toBe(3);
  });

  it('the same row changed on both sides ends the same on both (later change wins)', async () => {
    const supplier = await spoke.db.supplier.findFirstOrThrow({
      where: { tenantId, name: 'Chorsu' },
    });
    network.down = true;
    await spoke.db.supplier.update({
      where: { id: supplier.id },
      data: { phone: '+998900000001' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await hub.db.supplier.update({
      where: { id: supplier.id },
      data: { phone: '+998900000002' },
    });
    network.down = false;
    await sync();
    const onSpoke = await spoke.db.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    const onHub = await hub.db.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    expect(onSpoke.phone).toBe('+998900000002');
    expect(onHub.phone).toBe('+998900000002');
  });

  it('employees and settings changed on the centre reach the Kassa; staff PIN works on both', async () => {
    const cashier = await spoke.db.user.findFirstOrThrow({
      where: { tenantId, username: 'kassir' },
    });
    // A PIN set on the Kassa after attaching is hashed with the restaurant key.
    clearPinKeyCache();
    const hash = await hashPin(
      spoke.db,
      spoke.services.secrets,
      tenantId,
      cashier.id,
      '7315',
    );
    expect(hash.startsWith('t1:')).toBe(true);
    await spoke.db.user.update({
      where: { id: cashier.id },
      data: { pinHash: hash, displayName: 'Kassir Ali' },
    });
    await centreAdmin
      .put('/api/settings')
      .set('Origin', ORIGIN)
      .send({ name: 'Uchko‘prik Fast Food' })
      .then(() => undefined);
    await hub.db.tenant.update({
      where: { id: tenantId },
      data: { name: 'Uchko‘prik Fast Food' },
    });
    await sync();
    const onHub = await hub.db.user.findUniqueOrThrow({
      where: { id: cashier.id },
    });
    expect(onHub.displayName).toBe('Kassir Ali');
    // The centre (another server key) accepts the same PIN, refuses a wrong one.
    clearPinKeyCache();
    expect(
      (
        await verifyPin(
          hub.db,
          hub.services.secrets,
          tenantId,
          cashier.id,
          '7315',
          onHub.pinHash!,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await verifyPin(
          hub.db,
          hub.services.secrets,
          tenantId,
          cashier.id,
          '0000',
          onHub.pinHash!,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await spoke.db.tenant.findUniqueOrThrow({ where: { id: tenantId } }))
        .name,
    ).toBe('Uchko‘prik Fast Food');
  });

  it('an old (Kassa-key) PIN is upgraded at the next sign-in', async () => {
    const user = await spoke.db.user.findFirstOrThrow({
      where: { tenantId, username: 'owner' },
    });
    const old = await (
      await import('../src/lib/crypto.js')
    ).hashSecret(spoke.services.secrets.pepperPin(user.id, '1357'));
    clearPinKeyCache();
    const result = await verifyPin(
      spoke.db,
      spoke.services.secrets,
      tenantId,
      user.id,
      '1357',
      old,
    );
    expect(result.ok).toBe(true);
    expect(result.upgrade?.startsWith('t1:')).toBe(true);
  });

  it('orders numbered on the centre never collide with the Kassa’s numbers', async () => {
    const branch = await hub.db.branch.findFirstOrThrow({
      where: { tenantId },
    });
    const day = new Date('2026-11-15T00:00:00.000Z');
    const number = await hub.db.$transaction((tx) =>
      nextOrderNumber(tx, branch.id, day),
    );
    expect(number).toBe(5001);
    const kassa = await spoke.db.$transaction((tx) =>
      nextOrderNumber(tx, branch.id, day),
    );
    expect(kassa).toBe(1);
  });

  it('orders, payments and shifts made on the Kassa reach the centre (and back)', async () => {
    const category = await spoke.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await spoke.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Lavash' },
    });
    const variant = await spoke.db.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        name: 'Oddiy',
        price: 30000,
        cost: 12000,
      },
    });
    const cashier = spoke.agent();
    await login(cashier, slug, 'kassir').expect(200);
    network.down = true; // no internet: the Kassa still sells
    await cashier
      .post('/api/shifts/open')
      .set('Origin', ORIGIN)
      .send({ openingCash: 50000 })
      .expect(201);
    const order = await cashier
      .post('/api/orders')
      .set('Origin', ORIGIN)
      .send({
        idempotencyKey: randomUUID(),
        type: 'TAKEAWAY',
        items: [{ variantId: variant.id, quantity: 2 }],
      })
      .expect(201);
    await cashier
      .post(`/api/orders/${order.body.id}/payments`)
      .set('Origin', ORIGIN)
      .send({
        idempotencyKey: randomUUID(),
        method: 'CASH',
        amount: 60000,
        tendered: 60000,
      })
      .expect(201);
    network.down = false;
    await sync();
    const onHub = await hub.db.order.findUniqueOrThrow({
      where: { id: order.body.id },
      include: { items: true, payments: true },
    });
    expect(onHub.total).toBe(60000);
    expect(onHub.items).toHaveLength(1);
    expect(onHub.payments.map((p) => p.amount)).toEqual([60000]);
    expect(
      await hub.db.orderEvent.count({ where: { orderId: order.body.id } }),
    ).toBe(
      await spoke.db.orderEvent.count({ where: { orderId: order.body.id } }),
    );
    expect(
      await hub.db.cashShift.count({ where: { tenantId, status: 'OPEN' } }),
    ).toBe(1);
    // The Admin's report on the centre includes the Kassa's sale.
    const day = await centreAdmin.get('/api/orders?limit=50').expect(200);
    expect(JSON.stringify(day.body)).toContain(order.body.id);
  });

  it('keeps restaurants apart', async () => {
    // Another customer's licence can not write into this restaurant.
    const other = await hub.services.db.$transaction(async () => {
      const { receiveFromSpoke } =
        await import('../src/modules/replication/engine.js');
      const stranger = await hub.db.controlCustomer.create({
        data: { name: unique('Begona') },
      });
      return receiveFromSpoke(hub.db, hub.services.secrets, stranger.id, {
        tenantId,
        nodeId: 'k-aaaaaaaaaaaa',
        changes: [],
        since: 0,
      }).catch((error: Error & { code?: string }) => error.code);
    });
    expect(other).toBe('FORBIDDEN');
    // A change carrying another restaurant's tenant is refused (recorded, not applied).
    const { applyBatch } = await import('../src/modules/replication/engine.js');
    const foreignId = randomUUID();
    const counts = await hub.db.$transaction((tx) =>
      applyBatch(tx, tenantId, [
        {
          seq: 1,
          tbl: 'suppliers',
          pk: { id: foreignId },
          op: 'I',
          row: { id: foreignId, tenantId: randomUUID(), name: 'X' },
          delta: null,
          changedAt: new Date().toISOString(),
          origin: 'k-bbbbbbbbbbbb',
        },
      ]),
    );
    expect(counts.conflict).toBe(1);
    expect(
      await hub.db.supplier.findUnique({ where: { id: foreignId } }),
    ).toBeNull();
    // A tampered Kassa can not raise privileges on the centre.
    const owner = await hub.db.user.findFirstOrThrow({
      where: { tenantId, username: 'owner' },
    });
    const tenantRow = await hub.db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    const later = new Date(Date.now() + 60_000).toISOString();
    await hub.db.$transaction((tx) =>
      applyBatch(tx, tenantId, [
        {
          seq: 2,
          tbl: 'tenants',
          pk: { id: tenantId },
          op: 'U',
          row: {
            ...JSON.parse(JSON.stringify(tenantRow)),
            kind: 'PLATFORM',
          },
          delta: null,
          changedAt: later,
          origin: 'k-bbbbbbbbbbbb',
        },
        {
          seq: 3,
          tbl: 'users',
          pk: { id: owner.id },
          op: 'U',
          row: {
            ...JSON.parse(JSON.stringify(owner)),
            isPlatformAdmin: true,
          },
          delta: null,
          changedAt: later,
          origin: 'k-bbbbbbbbbbbb',
        },
      ]),
    );
    expect(
      (await hub.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).kind,
    ).toBe('BUSINESS');
    expect(
      (await hub.db.user.findUniqueOrThrow({ where: { id: owner.id } }))
        .isPlatformAdmin,
    ).toBe(false);
    // The licence's customer is linked; status shows a healthy queue on the Kassa.
    const status = await kassaAdmin.get('/api/replication/status').expect(200);
    expect(status.body).toMatchObject({
      attached: true,
      role: 'spoke',
      pending: 0,
    });
    void customerId;
  });
});
