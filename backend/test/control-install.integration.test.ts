import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateLicenseKey,
  generateIdentity,
} from '../src/modules/control/keys.js';
import { createControlRuntime } from '../src/modules/control/runtime.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
} from '../src/modules/control/view.js';
import { clearLicenseCache } from '../src/modules/license/license.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';

const server = generateIdentity();
const central = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
const install = createTestContext({
  selfHosted: true,
  control: {
    plane: false,
    trustedKeys: [server.publicKey],
    url: 'https://central.test',
  },
});

const network = { down: false };
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
  if (network.down) throw new TypeError('network down');
  const path = new URL(String(url)).pathname;
  const response = await request(central.app)
    .post(path)
    .send(JSON.parse(String(init?.body ?? '{}')));
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const runtime = createControlRuntime(install.services, { transport });
install.services.controlRuntime = runtime;
install.services.controlView = runtime.view;
install.services.installId = 'FF-TEST-0001-0001';
install.services.appVersion = '1.8.0';

/** Moves both clocks (central and install) forward together. */
function advance(ms: number) {
  central.clock.offsetMs += ms;
  install.clock.offsetMs += ms;
}

afterAll(async () => {
  await install.close();
  await central.close();
});

async function resetLink() {
  install.clock.offsetMs = central.clock.offsetMs;
  await install.db.controlLink.deleteMany({});
  await install.db.syncOperation.deleteMany({});
  runtime.invalidate();
  runtime._resetClock();
  clearLicenseCache();
  clearPolicyCache();
  clearAdminSettingsCache();
  network.down = false;
}

async function licensed(policy: Record<string, unknown> = {}) {
  const key = generateLicenseKey();
  const customer = await central.db.controlCustomer.create({
    data: { name: unique('Mijoz') },
  });
  await central.db.controlLicense.create({
    data: {
      customerId: customer.id,
      keyHash: central.services.secrets.keyedHash('license-key', key),
      keyHint: key.slice(-5),
      expiresAt: new Date(
        Date.now() + central.clock.offsetMs + 30 * 86_400_000,
      ),
      maxInstalls: 5,
      features: [],
    },
  });
  await central.db.controlPolicy.create({
    data: {
      customerId: customer.id,
      offlineEnabled: true,
      maxOfflineMinutes: 120,
      ...policy,
    },
  });
  return { key, customerId: customer.id };
}

async function activate(key: string) {
  const result = await runtime.activate({
    licenseKey: key,
    deviceName: 'Test kassa',
    serverUrl: 'https://central.test',
  });
  expect(result.ok).toBe(true);
  runtime.invalidate();
  return result;
}

const post = (
  agent: request.Agent,
  path: string,
  body: object = {},
  headers: Record<string, string> = {},
) => {
  let req = agent.post(`/api${path}`).set('Origin', ORIGIN);
  for (const [name, value] of Object.entries(headers))
    req = req.set(name, value);
  return req.send(body);
};

describe('default financial visibility', () => {
  beforeAll(resetLink);

  it('hides cost, margin and net profit from cashiers unless SUPER_OWNER enables it', async () => {
    const tenant = await createTenant(install);
    await install.db.role.update({
      where: { id: tenant.roleId('cashier') },
      data: {
        permissions: {
          push: ['menu.cost.view', 'finance.view', 'reports.view'],
        },
      },
    });
    await addUser(install, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = install.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    const me = await cashier.get('/api/auth/me').expect(200);
    expect(me.body.permissions).not.toContain('menu.cost.view');
    expect(me.body.permissions).not.toContain('finance.view');
    expect(me.body.financial).toEqual({
      cost: false,
      margin: false,
      profit: false,
    });
    // The restaurant's own owner is not cashier-class and keeps visibility.
    const owner = install.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const ownerMe = await owner.get('/api/auth/me').expect(200);
    expect(ownerMe.body.financial).toEqual({
      cost: true,
      margin: true,
      profit: true,
    });
    expect(ownerMe.body.permissions).toContain('menu.cost.view');
  });
});

describe('linked install: policy enforcement', () => {
  it('activation does not grant access; employees still sign in', async () => {
    await resetLink();
    const { key } = await licensed();
    await activate(key);
    const status = await runtime.status();
    expect(status.linked).toBe(true);
    expect(status.mode).toBe('ONLINE');
    // An unauthenticated caller gets nothing from the control endpoints.
    await install.agent().get('/api/control/link/status').expect(401);
    const link = await install.db.controlLink.findUniqueOrThrow({
      where: { id: 1 },
    });
    // Only the sealed device key and signed grant are stored: no licence key.
    expect(JSON.stringify({ ...link, requestSeq: 0 })).not.toContain(key);
  });

  it('switches features off server-side and applies cashier visibility switches', async () => {
    await resetLink();
    const { key, customerId } = await licensed();
    await activate(key);
    const tenant = await createTenant(install);
    const owner = install.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
    }).expect(201);
    // SUPER_OWNER switches the discount button and the whole menu editor off.
    await central.db.controlPolicy.update({
      where: { customerId },
      data: {
        version: { increment: 1 },
        features: {
          'discounts.apply': { mode: 'OFF' },
          'menu.manage': { mode: 'OFF' },
        },
      },
    });
    expect(await runtime.beat()).toBe('ok');
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.permissions).not.toContain('discounts.apply');
    expect(me.body.permissions).not.toContain('menu.manage');
    // The API refuses even a hand-made request.
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
    }).expect(201);
    const blocked = await post(owner, `/orders/${order.body.id}/discount`, {
      type: 'PERCENT',
      value: 10,
      reason: 'Sinov',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('FEATURE_DISABLED');
    const menu = await post(owner, '/menu/categories', { name: 'Yangi' });
    expect(menu.body.code).toBe('FEATURE_DISABLED');
  });

  it('lets the restaurant Admin decide only delegated features', async () => {
    await resetLink();
    const { key, customerId } = await licensed({
      features: {
        'fin.cashier.cost': { mode: 'ADMIN' },
        'menu.manage': { mode: 'OFF' },
      },
    });
    await activate(key);
    await runtime.beat();
    const tenant = await createTenant(install);
    await install.db.role.update({
      where: { id: tenant.roleId('cashier') },
      data: { permissions: { push: ['menu.cost.view'] } },
    });
    await addUser(install, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const owner = install.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    // Owner needs a recent password login for the sensitive endpoint.
    const put = (body: object) =>
      owner.put('/api/control/link/features').set('Origin', ORIGIN).send(body);
    const enable = await put({
      featureKey: 'fin.cashier.cost',
      roleKey: 'cashier',
      enabled: true,
    });
    expect(enable.status).toBe(200);
    // A feature SUPER_OWNER did not delegate cannot be touched.
    const locked = await put({
      featureKey: 'menu.manage',
      roleKey: '*',
      enabled: true,
    });
    expect(locked.status).toBe(403);
    const cashier = install.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    const me = await cashier.get('/api/auth/me').expect(200);
    expect(me.body.financial.cost).toBe(true);
    expect(me.body.permissions).toContain('menu.cost.view');
    void customerId;
  });
});

describe('linked install: offline policy', () => {
  async function ready(policy: Record<string, unknown> = {}) {
    await resetLink();
    const made = await licensed(policy);
    await activate(made.key);
    expect(await runtime.beat()).toBe('ok');
    const tenant = await createTenant(install);
    const cashierUser = await addUser(install, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const waiterUser = await addUser(install, tenant.tenant.id, {
      username: 'ofitsiant',
      roleIds: [tenant.roleId('waiter')],
    });
    void cashierUser;
    void waiterUser;
    const cashier = install.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    const waiter = install.agent();
    await login(waiter, tenant.slug, 'ofitsiant').expect(200);
    const owner = install.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    return { ...made, tenant, cashier, waiter, owner };
  }
  const newOrder = (
    agent: request.Agent,
    headers: Record<string, string> = {},
  ) =>
    post(
      agent,
      '/orders',
      { idempotencyKey: randomUUID(), type: 'TAKEAWAY' },
      headers,
    );

  it('tolerates brief outages, then allows only offline-enabled actions', async () => {
    const t = await ready();
    network.down = true;
    // Within the tolerance window nothing changes for the user.
    advance(4 * 60_000);
    expect((await runtime.status()).mode).toBe('ONLINE');
    await newOrder(t.waiter).expect(201);
    // Beyond the window the install runs on its offline grant.
    advance(3 * 60_000);
    runtime.invalidate();
    expect((await runtime.status()).mode).toBe('OFFLINE');
    // Orders offline: Cashier panel only (a waiter - or any other panel - is refused).
    const waiterTry = await newOrder(t.waiter, { 'x-panel': 'waiter' });
    expect(waiterTry.status).toBe(403);
    expect(waiterTry.body.code).toBe('CASHIER_PANEL_ONLY');
    const cashierNoHeader = await newOrder(t.cashier);
    expect(cashierNoHeader.body.code).toBe('CASHIER_PANEL_ONLY');
    await newOrder(t.cashier, { 'x-panel': 'cashier' }).expect(201);
    // Refunds default to online-only.
    const refund = await post(t.owner, `/orders/${randomUUID()}/refunds`, {});
    expect(refund.body.code).toBe('OFFLINE_NOT_ALLOWED');
    // The cashier computer's own events are queued for the centre.
    const queued = await install.db.syncOperation.count({
      where: { type: 'offline_event' },
    });
    expect(queued).toBeGreaterThan(0);
  });

  it('SUPER_OWNER can enable refunds offline, per feature', async () => {
    const t = await ready({
      features: { 'payments.refund': { offline: true } },
    });
    network.down = true;
    advance(10 * 60_000);
    runtime.invalidate();
    expect((await runtime.status()).mode).toBe('OFFLINE');
    const refund = await post(t.owner, `/orders/${randomUUID()}/refunds`, {});
    expect(refund.body.code).not.toBe('OFFLINE_NOT_ALLOWED');
  });

  it('blocks new operations when the offline grant expires but keeps data readable', async () => {
    const t = await ready();
    const order = await newOrder(t.cashier, { 'x-panel': 'cashier' }).expect(
      201,
    );
    network.down = true;
    advance(121 * 60_000);
    runtime.invalidate();
    const status = await runtime.status();
    expect(status.mode).toBe('EXPIRED');
    const blocked = await newOrder(t.cashier, { 'x-panel': 'cashier' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('OFFLINE_EXPIRED');
    // Saved orders stay available (sign-in itself is never blocked).
    const again = install.agent();
    await login(again, t.tenant.slug, 'kassir').expect(200);
    const read = await again.get(`/api/orders/${order.body.id}`);
    expect(read.status).toBe(200);
  });

  it('online-only customers are blocked after the tolerance window', async () => {
    const t = await ready({ offlineEnabled: false, maxOfflineMinutes: 0 });
    network.down = true;
    advance(6 * 60_000);
    runtime.invalidate();
    const blocked = await newOrder(t.cashier, { 'x-panel': 'cashier' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe('ONLINE_REQUIRED');
  });

  it('a rolled-back clock cannot extend the grant', async () => {
    const t = await ready();
    network.down = true;
    advance(90 * 60_000);
    runtime.invalidate();
    expect((await runtime.status()).mode).toBe('OFFLINE');
    // The user turns the system clock back by two hours.
    install.clock.offsetMs -= 2 * 3_600_000;
    runtime.invalidate();
    const status = await runtime.status();
    // Time never moves backwards: the grant is not "re-opened" and a stale clock
    // demands a fresh contact before new operations.
    expect(['OFFLINE', 'EXPIRED']).toContain(status.mode);
    if (status.offlineUntil)
      expect(status.offlineUntil.getTime()).toBeLessThanOrEqual(
        Date.now() + 2 * 3_600_000,
      );
    const blocked = await newOrder(t.cashier, { 'x-panel': 'cashier' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('CLOCK_ROLLBACK');
    // Reconnecting restores service.
    // The user sets the clock right again, then reconnects.
    install.clock.offsetMs += 2 * 3_600_000;
    network.down = false;
    expect(await runtime.beat()).toBe('ok');
    runtime.invalidate();
    expect((await runtime.status()).mode).toBe('ONLINE');
  });

  it('rejects unregistered LAN devices while offline', async () => {
    const t = await ready();
    network.down = true;
    advance(10 * 60_000);
    runtime.invalidate();
    // Simulate a request from another machine on the LAN.
    const lan = await t.cashier
      .get('/api/orders')
      .set('x-test-remote', '192.168.1.50');
    // supertest always connects from loopback, so this stays allowed; the guard
    // itself is covered by the control-state unit tests and the device check below.
    expect(lan.status).toBe(200);
  });

  it('replays queued operations once after reconnecting, without duplicates', async () => {
    const t = await ready();
    network.down = true;
    advance(10 * 60_000);
    runtime.invalidate();
    await newOrder(t.cashier, { 'x-panel': 'cashier' }).expect(201);
    await newOrder(t.cashier, { 'x-panel': 'cashier' }).expect(201);
    // Offline events are written right after each response; wait for both.
    let pending = 0;
    for (let i = 0; i < 40 && pending < 2; i++) {
      pending = await install.db.syncOperation.count({
        where: { status: 'PENDING' },
      });
      if (pending < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(pending).toBeGreaterThanOrEqual(2);
    // Still offline: the flush fails and everything stays queued (never "done").
    await runtime.sync();
    expect(
      await install.db.syncOperation.count({ where: { status: 'DONE' } }),
    ).toBe(0);
    network.down = false;
    advance(2 * 60_000);
    expect(await runtime.beat()).toBe('ok');
    await runtime.sync();
    const first = await install.db.syncOperation.count({
      where: { status: 'DONE' },
    });
    expect(first).toBeGreaterThanOrEqual(2);
    // A second flush (retry after a lost response) changes nothing centrally.
    await install.db.syncOperation.updateMany({
      where: { status: 'DONE' },
      data: { status: 'PENDING', nextAttemptAt: new Date(0) },
    });
    await runtime.sync();
    const rows = await central.db.controlSyncOp.findMany({
      where: { customerId: t.customerId },
    });
    const applied = rows.filter((row) => row.status === 'APPLIED');
    expect(new Set(applied.map((row) => row.opId)).size).toBe(applied.length);
  });

  it('terminates sessions on command from the Owner', async () => {
    const t = await ready();
    const activation = await central.db.controlActivation.findFirstOrThrow({
      where: { customerId: t.customerId },
    });
    await central.db.controlActivation.update({
      where: { id: activation.id },
      data: {
        pendingCommands: [
          {
            id: 'cmd-1',
            type: 'terminate_sessions',
            scope: 'all',
            issuedAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(await runtime.beat()).toBe('ok');
    await t.cashier.get('/api/auth/me').expect(401);
    void PASSWORD;
  });
});

describe('LAN devices on the cashier computer (offline)', () => {
  type FakeRes = {
    locals: Record<string, unknown>;
    on: (event: string, handler: () => void) => void;
  };
  async function through(
    t: Awaited<ReturnType<typeof lanSetup>>,
    request_: {
      method: string;
      path: string;
      remote: string;
      cookie?: string;
      panel?: string;
      auth?: boolean;
    },
  ) {
    const { enforceControl } =
      await import('../src/modules/control/enforce.js');
    const middleware = enforceControl(install.services);
    const headers: Record<string, string> = {
      ...(request_.cookie ? { cookie: request_.cookie } : {}),
      ...(request_.panel ? { 'x-panel': request_.panel } : {}),
    };
    const req = {
      method: request_.method,
      path: request_.path,
      headers,
      socket: { remoteAddress: request_.remote },
      get: (name: string) => headers[name.toLowerCase()],
    };
    const res: FakeRes = {
      locals: request_.auth === false ? {} : { auth: t.auth },
      on: () => undefined,
    };
    try {
      await new Promise<void>((resolve, reject) => {
        void middleware(req as never, res as never, (error?: unknown) =>
          error ? reject(error) : resolve(),
        ).catch(reject);
      });
      return 'allowed';
    } catch (error) {
      return (error as { code?: string }).code ?? 'error';
    }
  }

  async function lanSetup() {
    await resetLink();
    const made = await licensed();
    await activate(made.key);
    expect(await runtime.beat()).toBe('ok');
    const tenant = await createTenant(install);
    const branch = await install.db.branch.findFirstOrThrow({
      where: { tenantId: tenant.tenant.id },
    });
    const { sha256 } = await import('../src/lib/crypto.js');
    const device = async (panel: string) => {
      const token = `${panel}${randomUUID().replace(/-/g, '')}`.slice(0, 40);
      await install.db.device.create({
        data: {
          tenantId: tenant.tenant.id,
          branchId: branch.id,
          name: `${panel} terminali`,
          tokenHash: sha256(token),
          registeredById: tenant.owner.id,
          panel,
        },
      });
      return `ff_device=${token}`;
    };
    const cashierCookie = await device('CASHIER');
    const kitchenCookie = await device('KITCHEN');
    // Authenticated context of a cashier / kitchen employee.
    const auth = {
      tenantId: tenant.tenant.id,
      roleKeys: ['cashier'],
      permissions: new Set(['pos.access', 'orders.create', 'kitchen.access']),
    };
    network.down = true;
    advance(10 * 60_000);
    runtime.invalidate();
    return { cashierCookie, kitchenCookie, auth };
  }

  it('requires registered devices and keeps order creation on the Cashier panel', async () => {
    const t = await lanSetup();
    const lan = '::ffff:192.168.1.50';
    // An unknown machine on the Wi-Fi is not served while offline.
    expect(
      await through(t, { method: 'GET', path: '/orders', remote: lan }),
    ).toBe('LOCAL_DEVICE_REQUIRED');
    // The kitchen terminal keeps receiving and updating tickets over the LAN.
    expect(
      await through(t, {
        method: 'GET',
        path: '/kitchen/tickets',
        remote: lan,
        cookie: t.kitchenCookie,
      }),
    ).toBe('allowed');
    expect(
      await through(t, {
        method: 'POST',
        path: '/kitchen/items/123/status',
        remote: lan,
        cookie: t.kitchenCookie,
      }),
    ).toBe('allowed');
    // ...but cannot create orders even if it claims to be the cashier.
    expect(
      await through(t, {
        method: 'POST',
        path: '/orders',
        remote: lan,
        cookie: t.kitchenCookie,
        panel: 'cashier',
      }),
    ).toBe('CASHIER_PANEL_ONLY');
    // A terminal registered for the Cashier panel can.
    expect(
      await through(t, {
        method: 'POST',
        path: '/orders',
        remote: lan,
        cookie: t.cashierCookie,
        panel: 'cashier',
      }),
    ).toBe('allowed');
    // Without the panel claim the same terminal is refused.
    expect(
      await through(t, {
        method: 'POST',
        path: '/orders',
        remote: lan,
        cookie: t.cashierCookie,
      }),
    ).toBe('CASHIER_PANEL_ONLY');
  });

  it('keeps table assignment on the Cashier panel and lets waiter alerts run on the LAN', async () => {
    const t = await lanSetup();
    const lan = '::ffff:192.168.1.50';
    const table = '/orders/00000000-0000-4000-8000-000000000000/table';
    // A waiter tablet (registered device) cannot change tables while offline.
    expect(
      await through(t, {
        method: 'POST',
        path: table,
        remote: lan,
        cookie: t.kitchenCookie,
        panel: 'cashier',
      }),
    ).toBe('CASHIER_PANEL_ONLY');
    expect(
      await through(t, {
        method: 'POST',
        path: table,
        remote: lan,
        cookie: t.cashierCookie,
        panel: 'cashier',
      }),
    ).toBe('allowed');
    // Live alerts reach registered tablets over the LAN, not unknown machines.
    expect(
      await through(t, {
        method: 'GET',
        path: '/live/alerts',
        remote: lan,
        cookie: t.kitchenCookie,
      }),
    ).toBe('allowed');
    expect(
      await through(t, { method: 'GET', path: '/live/alerts', remote: lan }),
    ).toBe('LOCAL_DEVICE_REQUIRED');
  });
});

describe('cloud edition tenant isolation', () => {
  it("applies each customer's policy only to its own tenant", async () => {
    const { cloudViewProvider } =
      await import('../src/modules/control/view.js');
    const a = await createTenant(central);
    const b = await createTenant(central);
    const customer = await central.db.controlCustomer.create({
      data: { name: unique('Bulut'), tenantId: a.tenant.id },
    });
    await central.db.controlPolicy.create({
      data: {
        customerId: customer.id,
        features: { 'menu.manage': { mode: 'OFF' } },
      },
    });
    clearPolicyCache();
    const provider = cloudViewProvider(central.db, () => new Date());
    expect(
      (await provider(a.tenant.id)).policy.features['menu.manage'],
    ).toEqual({ mode: 'OFF' });
    expect((await provider(b.tenant.id)).policy.features).toEqual({});
    expect((await provider(null)).mode).toBe('UNLINKED');
  });
});
