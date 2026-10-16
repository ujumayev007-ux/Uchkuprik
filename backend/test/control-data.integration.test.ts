import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import { generateIdentity, signValue } from '../src/modules/control/keys.js';
import { provisionOwner } from '../src/modules/control/owner-admin.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import { createEventBus } from '../src/realtime/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';

// Owner access to hosted restaurants' data, and live connections that follow policy.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
const bus = createEventBus();
ctx.services.events = bus;
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
let http: Server;
let realtime: ReturnType<typeof attachRealtime>;
let base = '';
beforeAll(async () => {
  http = createHttpServer(ctx.app);
  realtime = attachRealtime(http, ctx.services, bus, ORIGIN);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await realtime.close();
  await new Promise((resolve) => http.close(resolve));
  await ctx.close();
});

const api = (agent: request.Agent) => ({
  get: (path: string) => agent.get(`/api${path}`),
  post: (path: string, body: object = {}) =>
    agent.post(`/api${path}`).set('Origin', ORIGIN).send(body),
});

const jsonOf = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function nextCode(secret: string) {
  ctx.clock.offsetMs += 31_000;
  return totpCode(secret, currentStep(Date.now() + ctx.clock.offsetMs));
}

async function ownerSession(reauth: boolean) {
  const email = `${unique('owner')}@example.com`;
  const created = await provisionOwner(ctx.db, ctx.services.secrets, {
    email,
    displayName: 'Super Owner',
    password: PASSWORD,
  });
  const agent = request.agent(ctx.app);
  const device = generateIdentity();
  const challenge = (await api(agent).post('/control/owner/challenge')).body
    .challenge as string;
  await api(agent)
    .post('/control/owner/login', {
      email,
      password: PASSWORD,
      challenge,
      deviceKey: device.publicKey,
      deviceSignature: signValue(device.privateKeyPem, { challenge, email }),
      deviceLabel: 'Test EXE',
      code: nextCode(created.mfaSecret),
    })
    .expect(200);
  if (reauth)
    await api(agent)
      .post('/control/owner/reauth', {
        password: PASSWORD,
        code: nextCode(created.mfaSecret),
      })
      .expect(200);
  return agent;
}

/** A hosted restaurant linked to a customer, with one finished and one open order. */
async function restaurant() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const branch = await ctx.db.branch.findFirstOrThrow({ where: { tenantId } });
  const category = await ctx.db.menuCategory.create({
    data: { tenantId, name: 'Taom' },
  });
  const product = await ctx.db.product.create({
    data: { tenantId, categoryId: category.id, name: 'Lavash' },
  });
  const variant = await ctx.db.productVariant.create({
    data: { tenantId, productId: product.id, name: 'Oddiy', price: 30_000 },
  });
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  await ctx.db.device.create({
    data: {
      tenantId,
      branchId: branch.id,
      name: 'Kassa 1',
      tokenHash: unique('hash'),
      registeredById: tenant.owner.id,
      panel: 'CASHIER',
    },
  });
  const customer = await ctx.db.controlCustomer.create({
    data: { name: unique('Mijoz'), tenantId },
  });
  await ctx.db.controlPolicy.create({ data: { customerId: customer.id } });
  clearPolicyCache();
  clearAdminSettingsCache();
  const staff = ctx.agent();
  await login(staff, tenant.slug, 'owner').expect(200);
  const order = await api(staff)
    .post('/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      customerName: 'Aziz Qidiruv',
      items: [{ variantId: variant.id, quantity: 2 }],
    })
    .expect(201);
  return { tenant, tenantId, customer, variant, staff, order: order.body };
}

describe('Owner access to hosted restaurant data', () => {
  it('lets the Owner browse one restaurant, never secrets, and audits every read', async () => {
    const a = await restaurant();
    const b = await restaurant();
    const owner = await ownerSession(true);
    const base_ = `/control/customers/${a.customer.id}/data`;

    const overview = (await api(owner).get(`${base_}/overview`).expect(200))
      .body;
    expect(overview.devices).toBe(1);
    expect(overview.users).toBeGreaterThanOrEqual(2);
    expect(overview.openOrders).toBe(1);

    const branches = (await api(owner).get(`${base_}/branches`).expect(200))
      .body;
    expect(branches.branches).toHaveLength(1);
    const devices = (await api(owner).get(`${base_}/devices`).expect(200)).body;
    expect(devices.devices[0].name).toBe('Kassa 1');
    const roles = (await api(owner).get(`${base_}/roles`).expect(200)).body;
    expect(
      roles.roles.map((r: { systemKey: string }) => r.systemKey),
    ).toContain('cashier');
    const users = (await api(owner).get(`${base_}/users?q=kass`).expect(200))
      .body;
    expect(users.users).toHaveLength(1);
    expect(users.users[0].roles).toEqual(['Kassir']);
    const settings = (await api(owner).get(`${base_}/settings`).expect(200))
      .body;
    expect(settings.defaultReceipt.widthMm).toBe(80);

    // Search finds this restaurant's order by customer name and number, not the other's.
    const found = (
      await api(owner)
        .get(`${base_}/orders?q=${encodeURIComponent('Qidiruv')}`)
        .expect(200)
    ).body.orders;
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(a.order.id);
    const byNumber = (
      await api(owner).get(`${base_}/orders?q=${a.order.number}`).expect(200)
    ).body.orders;
    expect(byNumber.every((o: { id: string }) => o.id === a.order.id)).toBe(
      true,
    );
    const detail = (
      await api(owner).get(`${base_}/orders/${a.order.id}`).expect(200)
    ).body;
    expect(detail.items[0].name).toBe('Lavash');

    // Tenant isolation: another restaurant's order is not reachable through this one.
    await api(owner).get(`${base_}/orders/${b.order.id}`).expect(404);
    const other = (
      await api(owner)
        .get(`/control/customers/${b.customer.id}/data/orders`)
        .expect(200)
    ).body.orders;
    expect(other.map((o: { id: string }) => o.id)).toEqual([b.order.id]);

    // No credentials or tokens anywhere.
    const everything = jsonOf([
      overview,
      branches,
      devices,
      roles,
      users,
      settings,
      found,
      detail,
    ]);
    for (const secret of [
      'passwordHash',
      'pinHash',
      'tokenHash',
      'mfaSecret',
      '$argon',
      'hash_',
    ])
      expect(everything).not.toContain(secret);

    // Every read is in the control audit log.
    const audit = await ctx.db.controlAuditLog.findMany({
      where: {
        customerId: a.customer.id,
        action: { startsWith: 'data.view.' },
      },
    });
    const kinds = new Set(audit.map((row) => row.action));
    for (const kind of [
      'overview',
      'branches',
      'devices',
      'roles',
      'users',
      'settings',
      'orders',
      'order',
    ])
      expect(kinds).toContain(`data.view.${kind}`);
  });

  it('needs a fresh sign-in for personal data and refuses restaurant sessions', async () => {
    const a = await restaurant();
    const withoutReauth = await ownerSession(false);
    // The sign-in counts as fresh for five minutes; later, personal data needs it again.
    ctx.clock.offsetMs += 6 * 60_000;
    const denied = await api(withoutReauth).get(
      `/control/customers/${a.customer.id}/data/users`,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('REAUTH_REQUIRED');
    // Non-sensitive overviews work without it.
    await api(withoutReauth)
      .get(`/control/customers/${a.customer.id}/data/overview`)
      .expect(200);
    // A restaurant employee session is not an Owner session.
    const staff = await api(a.staff).get(
      `/control/customers/${a.customer.id}/data/overview`,
    );
    expect([401, 403]).toContain(staff.status);
    // Customers that run on their own computer have no hosted data.
    const own = await ctx.db.controlCustomer.create({
      data: { name: unique('Oflayn') },
    });
    const reauthed = await ownerSession(true);
    await api(reauthed)
      .get(`/control/customers/${own.id}/data/overview`)
      .expect(404);
  });

  it('suspends an employee centrally: sessions end and sign-in is refused', async () => {
    const a = await restaurant();
    const owner = await ownerSession(true);
    const cashier = ctx.agent();
    await login(cashier, a.tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/auth/me').expect(200);
    const users = (
      await api(owner)
        .get(`/control/customers/${a.customer.id}/data/users?q=kassir`)
        .expect(200)
    ).body.users;
    await api(owner)
      .post(
        `/control/customers/${a.customer.id}/data/users/${users[0].id}/status`,
        {
          status: 'DISABLED',
        },
      )
      .expect(200);
    await cashier.get('/api/auth/me').expect(401);
    const again = await login(ctx.agent(), a.tenant.slug, 'kassir');
    expect(again.status).toBeGreaterThanOrEqual(400);
    const audit = await ctx.db.controlAuditLog.count({
      where: { customerId: a.customer.id, action: 'data.user.status' },
    });
    expect(audit).toBe(1);
    // A user of another restaurant cannot be touched through this customer.
    const b = await restaurant();
    const foreign = (
      await api(await ownerSession(true))
        .get(`/control/customers/${b.customer.id}/data/users`)
        .expect(200)
    ).body.users[0];
    await api(owner)
      .post(
        `/control/customers/${a.customer.id}/data/users/${foreign.id}/status`,
        { status: 'DISABLED' },
      )
      .expect(404);
  });

  it('resets a forgotten password without touching the restaurant data', async () => {
    const a = await restaurant();
    const owner = await ownerSession(true);
    const cashier = ctx.agent();
    await login(cashier, a.tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/auth/me').expect(200);
    const users = (
      await api(owner)
        .get(`/control/customers/${a.customer.id}/data/users?q=kassir`)
        .expect(200)
    ).body.users;
    const url = `/control/customers/${a.customer.id}/data/users/${users[0].id}/password`;
    const before = {
      tenants: await ctx.db.tenant.count(),
      orders: await ctx.db.order.count({
        where: { tenantId: a.tenant.tenant.id },
      }),
      customer: await ctx.db.controlCustomer.findUniqueOrThrow({
        where: { id: a.customer.id },
      }),
    };
    // Confirmation is required, and the new password must be strong.
    await api(owner).post(url, { password: 'Yangi-parol-2026' }).expect(400);
    await api(owner)
      .post(url, { password: 'qisqa', confirm: true })
      .expect(400);
    await api(owner)
      .post(url, { password: 'Yangi-parol-2026', confirm: true })
      .expect(200);
    // The old password and the old session are gone; the new password works.
    await cashier.get('/api/auth/me').expect(401);
    expect(
      (await login(ctx.agent(), a.tenant.slug, 'kassir')).status,
    ).toBeGreaterThanOrEqual(400);
    await login(
      ctx.agent(),
      a.tenant.slug,
      'kassir',
      'Yangi-parol-2026',
    ).expect(200);
    // History, tenant and licence record are unchanged.
    expect(await ctx.db.tenant.count()).toBe(before.tenants);
    expect(
      await ctx.db.order.count({ where: { tenantId: a.tenant.tenant.id } }),
    ).toBe(before.orders);
    const after = await ctx.db.controlCustomer.findUniqueOrThrow({
      where: { id: a.customer.id },
    });
    expect(after.tenantId).toBe(before.customer.tenantId);
    // Only a hash is stored and the audit rows never contain the password.
    const stored = await ctx.db.user.findUniqueOrThrow({
      where: { id: users[0].id },
    });
    expect(stored.passwordHash).not.toContain('Yangi-parol-2026');
    const rows = jsonOf([
      await ctx.db.controlAuditLog.findMany({
        where: { customerId: a.customer.id },
      }),
      await ctx.db.auditLog.findMany({
        where: { tenantId: a.tenant.tenant.id },
      }),
    ]);
    expect(rows).not.toContain('Yangi-parol-2026');
    expect(
      await ctx.db.controlAuditLog.count({
        where: {
          customerId: a.customer.id,
          action: 'data.user.password.reset',
        },
      }),
    ).toBe(1);
    // Another restaurant's employee cannot be reached through this customer.
    const b = await restaurant();
    const foreign = (
      await api(await ownerSession(true))
        .get(`/control/customers/${b.customer.id}/data/users`)
        .expect(200)
    ).body.users[0];
    await api(owner)
      .post(
        `/control/customers/${a.customer.id}/data/users/${foreign.id}/password`,
        { password: 'Yangi-parol-2026', confirm: true },
      )
      .expect(404);
  });

  it('sets and removes a PIN, ending PIN sessions only', async () => {
    const a = await restaurant();
    const owner = await ownerSession(true);
    const users = (
      await api(owner)
        .get(`/control/customers/${a.customer.id}/data/users?q=kassir`)
        .expect(200)
    ).body.users;
    const url = `/control/customers/${a.customer.id}/data/users/${users[0].id}/pin`;
    await api(owner).post(url, { pin: '4821' }).expect(400);
    await api(owner).post(url, { pin: '12', confirm: true }).expect(400);
    await api(owner).post(url, { pin: '4821', confirm: true }).expect(200);
    const set = await ctx.db.user.findUniqueOrThrow({
      where: { id: users[0].id },
    });
    expect(set.pinHash).not.toBeNull();
    expect(set.pinHash).not.toContain('4821');
    await api(owner).post(url, { pin: null, confirm: true }).expect(200);
    const removed = await ctx.db.user.findUniqueOrThrow({
      where: { id: users[0].id },
    });
    expect(removed.pinHash).toBeNull();
    const rows = jsonOf(
      await ctx.db.controlAuditLog.findMany({
        where: { customerId: a.customer.id },
      }),
    );
    expect(rows).not.toContain('4821');
  });
});

function socketFor(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(base, {
      path: '/api/realtime',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie, Origin: ORIGIN },
      reconnection: false,
    });
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

describe('live connections follow the policy', () => {
  it('stops order events for a role the Owner switched off, without reconnecting', async () => {
    const a = await restaurant();
    const loginCookie = async (username: string) => {
      const agent = ctx.agent();
      const res = await login(agent, a.tenant.slug, username).expect(200);
      return String(res.headers['set-cookie']).split(';')[0]!;
    };
    const cashierSocket = await socketFor(await loginCookie('kassir'));
    const ownerSocket = await socketFor(await loginCookie('owner'));
    const cashierSeen: string[] = [];
    const ownerSeen: string[] = [];
    cashierSocket.on('order.changed', () => cashierSeen.push('order'));
    ownerSocket.on('order.changed', () => ownerSeen.push('order'));

    const create = () =>
      api(a.staff)
        .post('/orders', {
          idempotencyKey: randomUUID(),
          type: 'TAKEAWAY',
          place: true,
          items: [{ variantId: a.variant.id, quantity: 1 }],
        })
        .expect(201);
    await create();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(cashierSeen.length).toBeGreaterThan(0);

    // The Owner removes order access from cashiers; connected tablets are updated at once.
    await ctx.db.controlPolicy.update({
      where: { customerId: a.customer.id },
      data: {
        features: { 'orders.view': { roles: { cashier: { enabled: false } } } },
        version: { increment: 1 },
      },
    });
    clearPolicyCache();
    clearAdminSettingsCache();
    const configChanged = new Promise((resolve) =>
      cashierSocket.once('config.changed', resolve),
    );
    bus.publish({ type: 'config.changed', tenantId: a.tenantId });
    await configChanged;
    await new Promise((resolve) => setTimeout(resolve, 600));
    cashierSeen.length = 0;
    ownerSeen.length = 0;
    await create();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(cashierSeen).toHaveLength(0);
    expect(ownerSeen.length).toBeGreaterThan(0);
    cashierSocket.close();
    ownerSocket.close();
  });

  it('refuses order events to staff without order or kitchen access from the start', async () => {
    const a = await restaurant();
    await addUser(ctx, a.tenantId, {
      username: 'kuryer',
      roleIds: [a.tenant.roleId('courier')],
    });
    const agent = ctx.agent();
    const res = await login(agent, a.tenant.slug, 'kuryer').expect(200);
    const socket = await socketFor(
      String(res.headers['set-cookie']).split(';')[0]!,
    );
    const seen: string[] = [];
    socket.on('order.changed', () => seen.push('order'));
    await api(a.staff)
      .post('/orders', {
        idempotencyKey: randomUUID(),
        type: 'TAKEAWAY',
        place: true,
        items: [{ variantId: a.variant.id, quantity: 1 }],
      })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(seen).toHaveLength(0);
    socket.close();
  });
});
