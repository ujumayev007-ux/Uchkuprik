import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import { readGrant } from '../src/modules/control/grant.js';
import {
  generateIdentity,
  signValue,
  verifyDocument,
} from '../src/modules/control/keys.js';
import { provisionOwner } from '../src/modules/control/owner-admin.js';
import {
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
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
afterAll(() => ctx.close());

const api = (agent: request.Agent) => ({
  get: (path: string) => agent.get(`/api${path}`),
  post: (path: string, body: object = {}) =>
    agent.post(`/api${path}`).set('Origin', ORIGIN).send(body),
  put: (path: string, body: object = {}) =>
    agent.put(`/api${path}`).set('Origin', ORIGIN).send(body),
  patch: (path: string, body: object = {}) =>
    agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body),
});

/** A fresh authenticator code for a step the account has not used yet. */
function nextCode(secret: string) {
  ctx.clock.offsetMs += 31_000;
  return totpCode(secret, currentStep(Date.now() + ctx.clock.offsetMs));
}

async function createOwner() {
  const email = `${unique('owner')}@example.com`;
  const created = await provisionOwner(ctx.db, ctx.services.secrets, {
    email,
    displayName: 'Super Owner',
    password: PASSWORD,
  });
  return { email, secret: created.mfaSecret };
}

async function ownerLogin(
  agent: request.Agent,
  owner: { email: string; secret: string },
  device = generateIdentity(),
  overrides: Record<string, unknown> = {},
) {
  const challenge = (await api(agent).post('/control/owner/challenge')).body
    .challenge as string;
  const body = {
    email: owner.email,
    password: PASSWORD,
    challenge,
    deviceKey: device.publicKey,
    deviceSignature: signValue(device.privateKeyPem, {
      challenge,
      email: owner.email,
    }),
    deviceLabel: 'Test EXE',
    code: nextCode(owner.secret),
    ...overrides,
  };
  return { res: await api(agent).post('/control/owner/login', body), device };
}

async function signedIn() {
  const owner = await createOwner();
  const agent = request.agent(ctx.app);
  const { res, device } = await ownerLogin(agent, owner);
  expect(res.status).toBe(200);
  // Sensitive actions need a fresh password + code.
  const reauth = () =>
    api(agent)
      .post('/control/owner/reauth', {
        password: PASSWORD,
        code: nextCode(owner.secret),
      })
      .expect(200);
  await reauth();
  return { agent, owner, device, reauth };
}

describe('owner authentication', () => {
  it('requires a valid device proof, password, approved device and MFA', async () => {
    const owner = await createOwner();
    const agent = request.agent(ctx.app);
    // Forged device signature.
    const forged = await ownerLogin(agent, owner, generateIdentity(), {
      deviceSignature: signValue(generateIdentity().privateKeyPem, { x: 1 }),
    });
    expect(forged.res.status).toBe(403);
    expect(forged.res.body.code).toBe('DEVICE_PROOF_INVALID');
    // Wrong password never creates a session.
    const wrong = await ownerLogin(agent, owner, generateIdentity(), {
      password: 'Boshqa-parol-1234',
    });
    expect(wrong.res.status).toBe(401);
    // First device is trusted only together with a valid code.
    const first = await ownerLogin(agent, owner);
    expect(first.res.status).toBe(200);
    const me = await api(agent).get('/control/owner/me').expect(200);
    expect(me.body.email).toBe(owner.email);
    // A second device must be approved from an approved one.
    const other = request.agent(ctx.app);
    const pending = await ownerLogin(other, owner);
    expect(pending.res.status).toBe(403);
    expect(pending.res.body.code).toBe('DEVICE_PENDING');
    await api(agent)
      .post('/control/owner/reauth', {
        password: PASSWORD,
        code: nextCode(owner.secret),
      })
      .expect(200);
    const devices = await api(agent).get('/control/owner/devices').expect(200);
    const waiting = devices.body.devices.find(
      (device: { status: string }) => device.status === 'PENDING',
    );
    await api(agent)
      .post(`/control/owner/devices/${waiting.id}/approve`)
      .expect(200);
    const approved = await ownerLogin(
      request.agent(ctx.app),
      owner,
      pending.device,
    );
    expect(approved.res.status).toBe(200);
  });

  it('locks the account after repeated failures and records them', async () => {
    const owner = await createOwner();
    const agent = request.agent(ctx.app);
    for (let i = 0; i < 5; i++)
      await ownerLogin(agent, owner, generateIdentity(), {
        password: 'Noto-gri-parol-9',
      });
    const locked = await ownerLogin(agent, owner);
    expect(locked.res.status).toBe(429);
    const denied = await ctx.db.controlAuditLog.count({
      where: { action: 'owner.login.bad_password', outcome: 'DENIED' },
    });
    expect(denied).toBeGreaterThan(0);
  });

  it('keeps restaurant sessions out of the control API and vice versa', async () => {
    const tenant = await createTenant(ctx);
    const staff = ctx.agent();
    await login(staff, tenant.slug, 'owner').expect(200);
    await api(staff).get('/control/customers').expect(401);
    const { agent } = await signedIn();
    await api(agent).get('/control/customers').expect(200);
    // The owner cookie is not a tenant session.
    await api(agent).get('/auth/me').expect(401);
    await api(request.agent(ctx.app)).get('/control/customers').expect(401);
  });

  it('requires step-up for sensitive actions', async () => {
    const owner = await createOwner();
    const agent = request.agent(ctx.app);
    await ownerLogin(agent, owner);
    // Advance past the re-authentication window.
    ctx.clock.offsetMs += 6 * 60_000;
    await api(agent)
      .post('/control/customers', { name: 'Reauth test' })
      .expect(403);
  });
});

async function createLicensedCustomer(
  agent: request.Agent,
  terms: Record<string, unknown> = {},
) {
  const customer = await api(agent)
    .post('/control/customers', { name: unique('Restoran') })
    .expect(201);
  const license = await api(agent)
    .post(`/control/customers/${customer.body.id}/licenses`, {
      months: 1,
      ...terms,
    })
    .expect(201);
  return {
    customerId: customer.body.id as string,
    licenseId: license.body.id as string,
    key: license.body.key as string,
  };
}

/** Plays the install: holds the device key and signs requests. */
function device(agent: request.Agent) {
  const identity = generateIdentity();
  let seq = 0;
  const activate = (
    key: string,
    extra: Record<string, unknown> = {},
    ts = Date.now() + ctx.clock.offsetMs,
  ) => {
    const body = {
      licenseKey: key,
      publicKey: identity.publicKey,
      deviceName: 'Kassa kompyuteri',
      installId: 'FF-AAAA-BBBB-CCCC',
      tenantKey: 'tenant-a',
      model: 'Test PC',
      os: 'Windows 11',
      platform: 'DESKTOP',
      appVersion: '1.8.0',
      ts,
      ...extra,
    };
    const proof = signValue(identity.privateKeyPem, {
      type: 'activate',
      ...body,
    });
    return api(agent).post('/control/device/activate', { ...body, proof });
  };
  const envelope = (
    type: 'heartbeat' | 'sync',
    activationId: string,
    payload: object,
    options: { seq?: number; ts?: number } = {},
  ) => {
    const useSeq = options.seq ?? ++seq;
    const ts = options.ts ?? Date.now() + ctx.clock.offsetMs;
    return {
      activationId,
      seq: useSeq,
      ts,
      payload,
      sig: signValue(identity.privateKeyPem, {
        type,
        activationId,
        seq: useSeq,
        ts,
        payload,
      }),
    };
  };
  const heartbeat = (
    activationId: string,
    payload: object = {},
    options: { seq?: number; ts?: number } = {},
  ) =>
    api(agent).post(
      '/control/device/heartbeat',
      envelope('heartbeat', activationId, payload, options),
    );
  const sync = (activationId: string, operations: object[]) =>
    api(agent).post(
      '/control/device/sync',
      envelope('sync', activationId, { operations }),
    );
  return { identity, activate, heartbeat, sync, envelope };
}

describe('licence lifecycle and activation', () => {
  it('stores only a keyed hash of the licence key and binds the device', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent, { maxInstalls: 1 });
    expect(lic.key).toMatch(/^FFL(-[0-9A-Z]{5}){4}$/);
    const row = await ctx.db.controlLicense.findUniqueOrThrow({
      where: { id: lic.licenseId },
    });
    expect(JSON.stringify(row)).not.toContain(lic.key);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);

    const pc = device(request.agent(ctx.app));
    const activated = await pc.activate(lic.key).expect(201);
    const grant = readGrant(activated.body.grant, [server.publicKey])!;
    expect(grant.status).toBe('ACTIVE');
    expect(grant.customerId).toBe(lic.customerId);
    expect(grant.activationId).toBe(activated.body.activationId);
    // Same installation may repeat activation (idempotent, no extra slot used).
    await pc.activate(lic.key).expect(201);
    // A second computer exceeds the device limit.
    const second = device(request.agent(ctx.app));
    const limited = await second.activate(lic.key).expect(409);
    expect(limited.body.code).toBe('ACTIVATION_LIMIT');
  });

  it('rejects unknown keys, forged proofs and foreign restaurants', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent, { maxInstalls: 3 });
    const pc = device(request.agent(ctx.app));
    await pc.activate('FFL-AAAAA-AAAAA-AAAAA-AAAAA').expect(400);
    // Wrong timestamp (replayed old proof).
    await pc.activate(lic.key, {}, Date.now() - 3_600_000).expect(403);
    await pc.activate(lic.key, { tenantKey: 'tenant-a' }).expect(201);
    // The licence is now bound to tenant-a; another restaurant cannot reuse it.
    const other = device(request.agent(ctx.app));
    const mismatch = await other
      .activate(lic.key, { tenantKey: 'tenant-b' })
      .expect(409);
    expect(mismatch.body.code).toBe('TENANT_MISMATCH');
  });

  it('suspension, revocation, renewal and expiry reach the device grant', async () => {
    const { agent, reauth } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const activated = await pc.activate(lic.key).expect(201);
    const id = activated.body.activationId as string;
    const statusOf = async () => {
      const beat = await pc.heartbeat(id).expect(200);
      const body = verifyDocument<{ grant: string }>(beat.body.response, [
        server.publicKey,
      ])!;
      return readGrant(body.grant, [server.publicKey])!;
    };
    expect((await statusOf()).status).toBe('ACTIVE');
    await api(agent)
      .post(`/control/licenses/${lic.licenseId}/suspend`)
      .expect(200);
    expect((await statusOf()).status).toBe('SUSPENDED');
    await api(agent)
      .post(`/control/licenses/${lic.licenseId}/resume`)
      .expect(200);
    expect((await statusOf()).status).toBe('ACTIVE');
    const before = (await statusOf()).licenseExpiresAt;
    await api(agent)
      .post(`/control/licenses/${lic.licenseId}/renew`, { months: 2 })
      .expect(200);
    expect(
      new Date((await statusOf()).licenseExpiresAt).getTime(),
    ).toBeGreaterThan(new Date(before).getTime());
    await api(agent)
      .post(`/control/licenses/${lic.licenseId}/revoke`)
      .expect(200);
    expect((await statusOf()).status).toBe('REVOKED');
    // Resuming a revoked licence is impossible and a new activation is refused.
    await api(agent)
      .post(`/control/licenses/${lic.licenseId}/resume`)
      .expect(409);
    await device(request.agent(ctx.app)).activate(lic.key).expect(400);
    void reauth;
    const events = await ctx.db.controlAuditLog.findMany({
      where: { customerId: lic.customerId },
      select: { action: true },
    });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'license.issue',
        'device.activate',
        'license.suspend',
        'license.resume',
        'license.renew',
        'license.revoke',
      ]),
    );
  });

  it('"Blokdan chiqarish" lifts every block at once and keeps the licence end date', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const activated = await pc.activate(lic.key).expect(201);
    const id = activated.body.activationId as string;
    const grantOf = async () => {
      const beat = await pc.heartbeat(id).expect(200);
      const body = verifyDocument<{ grant: string }>(beat.body.response, [
        server.publicKey,
      ])!;
      return readGrant(body.grant, [server.publicKey])!;
    };
    const ends = (await grantOf()).licenseExpiresAt;
    // Blocked three ways: customer stopped, licence suspended, computer blocked.
    await api(agent)
      .post(`/control/customers/${lic.customerId}/status`, { status: 'SUSPENDED' })
      .expect(200);
    await api(agent).post(`/control/licenses/${lic.licenseId}/suspend`).expect(200);
    await api(agent).post(`/control/devices/${id}/block`).expect(200);
    expect((await grantOf()).status).not.toBe('ACTIVE');
    const listed = await api(agent).get('/control/customers').expect(200);
    const row = listed.body.customers.find(
      (item: { id: string }) => item.id === lic.customerId,
    );
    expect(row.blocked).toBe(true);
    expect(row.blockReasons).toEqual(['CUSTOMER', 'LICENSE', 'DEVICE']);

    const unblocked = await api(agent)
      .post(`/control/customers/${lic.customerId}/unblock`)
      .expect(200);
    expect(unblocked.body).toMatchObject({ customer: true, licenses: 1, devices: 1 });
    // The device receives it with its next check-in; the end date is unchanged.
    const grant = await grantOf();
    expect(grant.status).toBe('ACTIVE');
    expect(grant.licenseExpiresAt).toBe(ends);
    const detail = await api(agent).get(`/control/customers/${lic.customerId}`).expect(200);
    expect(detail.body.status).toBe('ACTIVE');
    expect(detail.body.blockReasons).toEqual([]);
    // Unblocking again changes nothing; a revoked licence is never brought back.
    await api(agent)
      .post(`/control/customers/${lic.customerId}/unblock`)
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ customer: false, licenses: 0, devices: 0 }));
    await api(agent).post(`/control/licenses/${lic.licenseId}/revoke`).expect(200);
    await api(agent).post(`/control/customers/${lic.customerId}/unblock`).expect(200);
    expect((await grantOf()).status).toBe('REVOKED');
    const events = await ctx.db.controlAuditLog.findMany({
      where: { customerId: lic.customerId, action: 'customer.unblock' },
    });
    expect(events.length).toBe(3);
  });

  it('a restaurant terminal is activated only by the Owner (signed command, audited)', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent, { maxInstalls: 1 });
    const pc = device(request.agent(ctx.app));
    const activated = await pc.activate(lic.key).expect(201);
    const id = activated.body.activationId as string;
    const localId = randomUUID();
    const terminal = {
      localId,
      name: 'Kassa 2',
      branchName: 'Markaziy',
      panel: 'CASHIER',
      status: 'PENDING',
    };
    await pc.heartbeat(id, { terminals: [terminal] }).expect(200);
    const listed = (
      await api(agent).get(`/control/devices?customerId=${lic.customerId}`)
    ).body.devices[0].terminals[0];
    expect(listed).toMatchObject({ localId, presence: 'PENDING' });
    // Unknown terminal and a terminal of another install are not found.
    await api(agent)
      .post(`/control/devices/${id}/terminals/${randomUUID()}/approve`)
      .expect(404);
    await api(agent)
      .post(`/control/devices/${id}/terminals/${localId}/approve`)
      .expect(200);
    // Decided once only.
    await api(agent)
      .post(`/control/devices/${id}/terminals/${localId}/reject`)
      .expect(409);
    const beat = await pc.heartbeat(id, { terminals: [terminal] }).expect(200);
    const doc = verifyDocument<{
      commands: { type: string; localId?: string; approve?: boolean }[];
    }>(beat.body.response, [server.publicKey])!;
    expect(doc.commands).toContainEqual(
      expect.objectContaining({
        type: 'device_approval',
        localId,
        approve: true,
      }),
    );
    const audit = await ctx.db.controlAuditLog.findFirst({
      where: { action: 'terminal.approve', customerId: lic.customerId },
    });
    expect(audit).not.toBeNull();
    // Without an Owner session nobody can approve.
    await api(request.agent(ctx.app))
      .post(`/control/devices/${id}/terminals/${localId}/approve`)
      .expect(401);
  });

  it('replaces a device: the slot is freed and the old one is revoked', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent, { maxInstalls: 1 });
    const oldPc = device(request.agent(ctx.app));
    const activated = await oldPc.activate(lic.key).expect(201);
    const id = activated.body.activationId as string;
    await oldPc.heartbeat(id, { currentUser: 'kassir1' }).expect(200);
    await api(agent).post(`/control/devices/${id}/replace`).expect(200);
    const beat = await oldPc.heartbeat(id).expect(200);
    const doc = verifyDocument<{ grant: string; commands: { type: string }[] }>(
      beat.body.response,
      [server.publicKey],
    )!;
    expect(readGrant(doc.grant, [server.publicKey])!.status).toBe('REVOKED');
    expect(doc.commands.map((command) => command.type)).toContain(
      'terminate_sessions',
    );
    const newPc = device(request.agent(ctx.app));
    await newPc.activate(lic.key).expect(201);
    // The replaced installation can never come back with its old key.
    await oldPc.activate(lic.key).expect(403);
  });
});

describe('device channel security', () => {
  it('rejects bad signatures and replayed counters, records presence', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const activated = await pc.activate(lic.key).expect(201);
    const id = activated.body.activationId as string;
    await pc
      .heartbeat(
        id,
        { currentUser: 'kassir1', appVersion: '1.8.0' },
        { seq: 10 },
      )
      .expect(200);
    // The same counter cannot be reused (replay).
    await pc.heartbeat(id, {}, { seq: 10 }).expect(409);
    await pc.heartbeat(id, {}, { seq: 9 }).expect(409);
    // Another device key cannot speak for this activation.
    const intruder = device(request.agent(ctx.app));
    await intruder.heartbeat(id, {}, { seq: 99 }).expect(403);
    // Stale timestamps are refused.
    await pc
      .heartbeat(id, {}, { seq: 11, ts: Date.now() - 3_600_000 })
      .expect(403);
    const list = await api(agent)
      .get(`/control/devices?customerId=${lic.customerId}`)
      .expect(200);
    expect(list.body.devices[0]).toMatchObject({
      presence: 'ONLINE',
      currentUser: 'kassir1',
      appVersion: '1.8.0',
      deviceName: 'Kassa kompyuteri',
    });
    const suspicious = await ctx.db.controlAuditLog.count({
      where: { customerId: lic.customerId, outcome: 'DENIED' },
    });
    expect(suspicious).toBeGreaterThanOrEqual(2);
  });

  it('applies synchronized operations exactly once and reports conflicts', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const id = (await pc.activate(lic.key).expect(201)).body
      .activationId as string;
    const opId = randomUUID();
    const operation = {
      opId,
      type: 'daily_summary',
      key: 'main:2026-10-16',
      data: { orders: 12, total: 1_540_000 },
    };
    const first = await pc.sync(id, [operation]).expect(200);
    const body = (response: string) =>
      verifyDocument<{ results: { opId: string; status: string }[] }>(
        response,
        [server.publicKey],
      )!.results;
    expect(body(first.body.response)[0]!.status).toBe('APPLIED');
    // Retry of the same operation (lost response): acknowledged, not applied twice.
    const retry = await pc.sync(id, [operation]).expect(200);
    expect(body(retry.body.response)[0]!.status).toBe('DUPLICATE');
    // Same business key with different content is an explicit conflict.
    const clash = await pc
      .sync(id, [
        { ...operation, opId: randomUUID(), data: { orders: 13, total: 1 } },
      ])
      .expect(200);
    expect(body(clash.body.response)[0]!.status).toBe('CONFLICT');
    const stored = await ctx.db.controlSyncOp.findMany({
      where: { customerId: lic.customerId, status: 'APPLIED' },
    });
    expect(stored).toHaveLength(1);
    const ledger = await api(agent)
      .get(`/control/customers/${lic.customerId}/sync`)
      .expect(200);
    expect(
      ledger.body.operations.some(
        (op: { status: string }) => op.status === 'CONFLICT',
      ),
    ).toBe(true);
  });

  it("never lets one customer's device write into another customer", async () => {
    const { agent } = await signedIn();
    const a = await createLicensedCustomer(agent);
    const b = await createLicensedCustomer(agent);
    const pcA = device(request.agent(ctx.app));
    const pcB = device(request.agent(ctx.app));
    const idA = (await pcA.activate(a.key).expect(201)).body.activationId;
    const idB = (
      await pcB.activate(b.key, { installId: 'FF-DDDD-EEEE-FFFF' }).expect(201)
    ).body.activationId;
    const opId = randomUUID();
    await pcA
      .sync(idA, [{ opId, type: 'offline_event', data: { note: 'A' } }])
      .expect(200);
    // The same opId from customer B is its own operation: ledgers are per customer.
    await pcB
      .sync(idB, [{ opId, type: 'offline_event', data: { note: 'B' } }])
      .expect(200);
    const rowsA = await ctx.db.controlSyncOp.count({
      where: { customerId: a.customerId, opId },
    });
    const rowsB = await ctx.db.controlSyncOp.count({
      where: { customerId: b.customerId, opId },
    });
    expect([rowsA, rowsB]).toEqual([1, 1]);
    // A device cannot sign for another activation.
    await pcA
      .sync(idB, [{ opId: randomUUID(), type: 'offline_event', data: {} }])
      .expect(403);
  });
});

describe('policy', () => {
  it('versions policy changes and carries them in the signed grant', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const id = (await pc.activate(lic.key).expect(201)).body
      .activationId as string;
    const saved = await api(agent)
      .put(`/control/customers/${lic.customerId}/policy`, {
        features: {
          'payments.refund': { offline: true },
          'menu.manage': { mode: 'OFF' },
          'fin.cashier.cost': { mode: 'ADMIN' },
        },
        offlineEnabled: true,
        maxOfflineMinutes: 240,
        minAppVersion: null,
      })
      .expect(200);
    expect(saved.body.version).toBeGreaterThan(1);
    const beat = await pc.heartbeat(id).expect(200);
    const doc = verifyDocument<{ grant: string }>(beat.body.response, [
      server.publicKey,
    ])!;
    const grant = readGrant(doc.grant, [server.publicKey])!;
    expect(grant.policy.version).toBe(saved.body.version);
    expect(grant.policy.offlineEnabled).toBe(true);
    expect(grant.policy.features['menu.manage']).toEqual({ mode: 'OFF' });
    // Offline authorization window follows the policy (4 hours).
    expect(
      new Date(grant.expiresAt).getTime() - new Date(grant.issuedAt).getTime(),
    ).toBe(240 * 60_000);
    await api(agent)
      .put(`/control/customers/${lic.customerId}/policy`, {
        features: { 'not.a.feature': { mode: 'OFF' } },
        offlineEnabled: false,
        maxOfflineMinutes: 0,
        minAppVersion: null,
      })
      .expect(400);
    const audit = await ctx.db.controlAuditLog.findFirst({
      where: { customerId: lic.customerId, action: 'policy.update' },
      orderBy: { id: 'desc' },
    });
    expect(JSON.stringify(audit?.data)).toContain('menu.manage');
  });
});

describe('migration fingerprints', () => {
  it('publishes non-secret fingerprints so a moved server can be compared with the old one', async () => {
    const info = (await request(ctx.app).get('/api/control/info').expect(200))
      .body;
    expect(info.plane).toBe(true);
    expect(info.signingKey).toMatch(/^[0-9a-f]{16}$/);
    expect(info.secretCheck).toMatch(/^[0-9a-f]{16}$/);
    const text = JSON.stringify(info);
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain(server.privateKeyPem.slice(40, 80));
    // Stable: the same keys always give the same values.
    const again = (await request(ctx.app).get('/api/control/info').expect(200))
      .body;
    expect(again).toEqual(info);
  });
});

describe('local-network exception (vendor only)', () => {
  const baseBody = {
    features: {},
    offlineEnabled: false,
    maxOfflineMinutes: 0,
    minAppVersion: null,
  };

  it('is granted with an expiry by the Owner, travels in the signed grant, survives other edits and can be revoked', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const id = (await pc.activate(lic.key).expect(201)).body
      .activationId as string;
    const grantOf = async () => {
      const beat = await pc.heartbeat(id).expect(200);
      const doc = verifyDocument<{ grant: string }>(beat.body.response, [
        server.publicKey,
      ])!;
      return readGrant(doc.grant, [server.publicKey])!;
    };
    expect((await grantOf()).policy.network.override).toBeNull();

    await api(agent)
      .put(`/control/customers/${lic.customerId}/policy`, {
        ...baseBody,
        networkOverride: {
          days: 2,
          roles: ['cashier'],
          reason: 'Masofaviy yordam',
        },
      })
      .expect(200);
    const granted = (await grantOf()).policy.network.override!;
    expect(granted.roles).toEqual(['cashier']);
    expect(granted.reason).toBe('Masofaviy yordam');
    const hours =
      (Date.parse(granted.expiresAt) - Date.parse(granted.grantedAt)) /
      3_600_000;
    expect(hours).toBe(48);

    // Editing something else keeps the exception (the field was not sent).
    await api(agent)
      .put(`/control/customers/${lic.customerId}/policy`, {
        ...baseBody,
        offlineEnabled: true,
        maxOfflineMinutes: 60,
      })
      .expect(200);
    expect((await grantOf()).policy.network.override?.reason).toBe(
      'Masofaviy yordam',
    );

    // Limits and a stated reason are mandatory.
    for (const bad of [
      { days: 0, roles: [], reason: 'Sabab bor' },
      { days: 91, roles: [], reason: 'Sabab bor' },
      { days: 3, roles: [], reason: 'x' },
      { days: 3, roles: ['Bad Role'], reason: 'Sabab bor' },
    ])
      await api(agent)
        .put(`/control/customers/${lic.customerId}/policy`, {
          ...baseBody,
          networkOverride: bad,
        })
        .expect(400);

    await api(agent)
      .put(`/control/customers/${lic.customerId}/policy`, {
        ...baseBody,
        networkOverride: null,
      })
      .expect(200);
    expect((await grantOf()).policy.network.override).toBeNull();
    const audits = await ctx.db.controlAuditLog.findMany({
      where: { customerId: lic.customerId, action: 'policy.update' },
      orderBy: { id: 'asc' },
    });
    const texts = audits.map((row) => JSON.stringify(row.data));
    expect(texts.some((text) => text.includes('Masofaviy yordam'))).toBe(true);
    expect(texts.some((text) => text.includes('revoked'))).toBe(true);
  });

  it('a restaurant user can not grant it', async () => {
    const tenant = await createTenant(ctx);
    const admin = request.agent(ctx.app);
    await login(admin, tenant.slug, 'owner').expect(200);
    const customerId = randomUUID();
    const attempt = await api(admin).put(
      `/control/customers/${customerId}/policy`,
      {
        ...baseBody,
        networkOverride: {
          days: 30,
          roles: [],
          reason: 'O‘zim ruxsat beraman',
        },
      },
    );
    expect([401, 403, 404]).toContain(attempt.status);
  });
});

/** The install's first launch: a signed registration with no privileges of its own. */
function registration(agent: request.Agent, identity = generateIdentity()) {
  const send = (
    extra: Record<string, unknown> = {},
    options: { badProof?: boolean; ts?: number } = {},
  ) => {
    const body = {
      publicKey: identity.publicKey,
      installId: `FF-${unique('R').slice(-4).toUpperCase()}-1111-2222`,
      deviceName: 'KASSA-PC',
      platform: 'DESKTOP',
      appVersion: '1.14.4',
      restaurantName: 'Yangi Oshxona',
      tenantKey: unique('tenant'),
      installedAt: new Date(
        Date.now() + ctx.clock.offsetMs - 60_000,
      ).toISOString(),
      hasLocalLicense: false,
      ts: options.ts ?? Date.now() + ctx.clock.offsetMs,
      ...extra,
    };
    const proof = options.badProof
      ? signValue(generateIdentity().privateKeyPem, {
          type: 'register',
          ...body,
        })
      : signValue(identity.privateKeyPem, { type: 'register', ...body });
    return {
      body,
      res: api(agent).post('/control/device/register', { ...body, proof }),
    };
  };
  return { identity, send };
}

describe('registration, trial and Owner events', () => {
  const HOUR = 3_600_000;

  it('a new install registers once, gets exactly one trial, and the Owner is notified once', async () => {
    const { agent } = await signedIn();
    // Settings live in the database: start from the documented defaults.
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 72 })
      .expect(200);
    const guest = request.agent(ctx.app);
    const first = registration(guest);
    const sent = first.send();
    const created = await sent.res;
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('ASSIGNED');
    expect(created.body.licenseKey).toMatch(/^FFL(-[0-9A-Z]{5}){4}$/);
    // Retrying (lost response, restart, upgrade) is the same registration, not a second one.
    const retried = await api(guest).post('/control/device/register', {
      ...sent.body,
      proof: signValue(first.identity.privateKeyPem, {
        type: 'register',
        ...sent.body,
      }),
    });
    expect(retried.status).toBe(200);
    expect(retried.body.registrationId).toBe(created.body.registrationId);
    expect(
      await ctx.db.controlRegistration.count({
        where: { id: created.body.registrationId },
      }),
    ).toBe(1);
    const events = await ctx.db.controlEvent.findMany({
      where: { registrationId: created.body.registrationId },
    });
    expect(events.map((event) => event.type).sort()).toEqual([
      'registration.new',
      'trial.assigned',
    ]);

    // The Owner sees both as unread and can mark them read; nothing is lost while closed.
    const inbox = await api(agent).get('/control/events?unread=1').expect(200);
    expect(inbox.body.unread).toBeGreaterThanOrEqual(2);
    expect(
      inbox.body.events.some(
        (e: { type: string }) => e.type === 'registration.new',
      ),
    ).toBe(true);
    const marked = await api(agent)
      .post('/control/events/read', { all: true })
      .expect(200);
    expect(marked.body.marked).toBeGreaterThanOrEqual(2);
    expect(
      (await api(agent).get('/control/events?unread=1').expect(200)).body
        .unread,
    ).toBe(0);

    // The same installation under another key does not earn a second trial.
    const dup = await registration(guest).send({
      installId: sent.body.installId,
      tenantKey: sent.body.tenantKey,
    }).res;
    expect(dup.body.status).toBe('PENDING');
    expect(dup.body.licenseKey).toBeUndefined();
  });

  it('forged, stale or malformed registrations are refused and create nothing', async () => {
    const guest = request.agent(ctx.app);
    const reg = registration(guest);
    expect((await reg.send({}, { badProof: true }).res).status).toBe(403);
    expect(
      (
        await reg.send({}, { ts: Date.now() + ctx.clock.offsetMs - 3_600_000 })
          .res
      ).status,
    ).toBe(403);
    expect((await reg.send({ appVersion: '<script>' }).res).status).toBe(400);
    expect((await reg.send({ publicKey: 'short' }).res).status).toBe(400);
    expect(
      await ctx.db.controlRegistration.count({
        where: { publicKey: reg.identity.publicKey },
      }),
    ).toBe(0);
  });

  it('old or already-licensed installs wait for the Owner instead of receiving a trial', async () => {
    const { agent } = await signedIn();
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 72 })
      .expect(200);
    const guest = request.agent(ctx.app);
    const old = await registration(guest).send({
      installedAt: new Date(
        Date.now() + ctx.clock.offsetMs - 10 * 24 * HOUR,
      ).toISOString(),
    }).res;
    expect(old.status).toBe(201);
    expect(old.body.status).toBe('PENDING');
    expect(old.body.licenseKey).toBeUndefined();
    const licensed = await registration(guest).send({ hasLocalLicense: true })
      .res;
    expect(licensed.body.status).toBe('PENDING');
    // The Owner reviews and assigns one of them to a new customer with a licence.
    const list = await api(agent)
      .get('/control/registrations?status=PENDING')
      .expect(200);
    expect(
      list.body.registrations.some(
        (r: { id: string }) => r.id === old.body.registrationId,
      ),
    ).toBe(true);
    const assigned = await api(agent)
      .post(`/control/registrations/${old.body.registrationId}/assign`, {
        newCustomer: { name: unique('Eski mijoz') },
        mode: 'months',
        months: 3,
      })
      .expect(200);
    expect(assigned.body.customerId).toBeTruthy();
    // Assigning twice is refused.
    await api(agent)
      .post(`/control/registrations/${old.body.registrationId}/assign`, {
        customerId: assigned.body.customerId,
        mode: 'months',
        months: 1,
      })
      .expect(409);
    // A customer gets one trial: the second request for the same customer is refused.
    const again = await registration(guest).send({ hasLocalLicense: true }).res;
    await api(agent)
      .post(`/control/registrations/${again.body.registrationId}/assign`, {
        customerId: assigned.body.customerId,
        mode: 'trial',
      })
      .expect(200);
    const third = await registration(guest).send({ hasLocalLicense: true }).res;
    await api(agent)
      .post(`/control/registrations/${third.body.registrationId}/assign`, {
        customerId: assigned.body.customerId,
        mode: 'trial',
      })
      .expect(409);
  });

  it('the trial lasts exactly 72 hours from the first activation, never restarts and converts without a new key', async () => {
    const { agent } = await signedIn();
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 72 })
      .expect(200);
    const guest = request.agent(ctx.app);
    const reg = registration(guest);
    const sent = reg.send();
    const created = await sent.res;
    const key = created.body.licenseKey as string;
    const tenantKey = { tenantKey: sent.body.tenantKey };
    // Time passes before the key is used: the clock has not started.
    ctx.clock.offsetMs += 5 * HOUR;
    const pc = device(request.agent(ctx.app));
    const startedAt = Date.now() + ctx.clock.offsetMs;
    const activated = await pc.activate(key, tenantKey).expect(201);
    const grant = readGrant(activated.body.grant, [server.publicKey])!;
    expect(grant.trial).toBe(true);
    const end = Date.parse(grant.licenseExpiresAt);
    expect(Math.abs(end - (startedAt + 72 * HOUR))).toBeLessThan(5_000);
    // Offline leases can never outlive the trial.
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(end);
    const license = await ctx.db.controlLicense.findFirstOrThrow({
      where: { keyHint: key.slice(-5) },
    });
    expect(license.trialStartedAt).not.toBeNull();
    // Activating the same device again (restart, reinstall of the app) does not move the end.
    ctx.clock.offsetMs += 10 * HOUR;
    const again = await pc.activate(key, tenantKey).expect(201);
    expect(
      Date.parse(
        readGrant(again.body.grant, [server.publicKey])!.licenseExpiresAt,
      ),
    ).toBe(end);
    // Another computer with the same key does not get a second trial (one installation).
    const other = device(request.agent(ctx.app));
    await other.activate(key, tenantKey).expect(409);
    const started = await ctx.db.controlEvent.count({
      where: { type: 'trial.started', customerId: license.customerId },
    });
    expect(started).toBe(1);
    const heartbeat = await pc
      .heartbeat(activated.body.activationId)
      .expect(200);
    const doc = verifyDocument<{ grant: string }>(heartbeat.body.response, [
      server.publicKey,
    ])!;
    expect(
      Date.parse(readGrant(doc.grant, [server.publicKey])!.licenseExpiresAt),
    ).toBe(end);
    // Converting to a paid term needs no new key and keeps the activation (the Owner
    // confirms with a fresh password and code, hours later).
    const later = await signedIn();
    await api(later.agent)
      .post(`/control/licenses/${license.id}/renew`, { months: 1 })
      .expect(200);
    const converted = await pc
      .heartbeat(activated.body.activationId)
      .expect(200);
    const doc2 = verifyDocument<{ grant: string }>(converted.body.response, [
      server.publicKey,
    ])!;
    const grant2 = readGrant(doc2.grant, [server.publicKey])!;
    expect(grant2.trial).toBeUndefined();
    expect(Date.parse(grant2.licenseExpiresAt)).toBeGreaterThan(
      end + 20 * 24 * HOUR,
    );
  });

  it('the Owner controls automatic trials and their length', async () => {
    const { agent } = await signedIn();
    await api(agent)
      .put('/control/registry-settings', { autoTrial: false, trialHours: 72 })
      .expect(200);
    const guest = request.agent(ctx.app);
    const off = await registration(guest).send().res;
    expect(off.body.status).toBe('PENDING');
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 24 })
      .expect(200);
    const shorterSent = registration(guest).send();
    const shorter = await shorterSent.res;
    const pc = device(request.agent(ctx.app));
    const grant = readGrant(
      (
        await pc
          .activate(shorter.body.licenseKey, {
            tenantKey: shorterSent.body.tenantKey,
          })
          .expect(201)
      ).body.grant,
      [server.publicKey],
    )!;
    const license = await ctx.db.controlLicense.findFirstOrThrow({
      where: { keyHint: (shorter.body.licenseKey as string).slice(-5) },
    });
    expect(license.trialHours).toBe(24);
    expect(
      Date.parse(grant.licenseExpiresAt) - license.trialStartedAt!.getTime(),
    ).toBe(24 * HOUR);
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 0 })
      .expect(400);
    await api(agent)
      .put('/control/registry-settings', { autoTrial: true, trialHours: 72 })
      .expect(200);
  });
});

describe('Owner device management', () => {
  /** Requests signed with any device key (the new one after "Device ID yangilash"). */
  let counter = Date.now() * 10;
  const signed = (
    identity: { privateKeyPem: string },
    type: string,
    activationId: string,
    payload: object,
  ) => {
    const seq = ++counter;
    const ts = Date.now() + ctx.clock.offsetMs;
    return {
      activationId,
      seq,
      ts,
      payload,
      sig: signValue(identity.privateKeyPem, { type, activationId, seq, ts, payload }),
    };
  };

  it('names, the Windows name, a new Device ID with approval and old devices', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent, { maxInstalls: 1 });
    const pc = device(request.agent(ctx.app));
    const id = (await pc.activate(lic.key).expect(201)).body.activationId as string;
    const rows = async (archived = false) =>
      (
        await api(agent)
          .get(`/control/devices?customerId=${lic.customerId}${archived ? '&archived=true' : ''}`)
          .expect(200)
      ).body.devices as Record<string, unknown>[];
    const row = async (deviceId: string) => (await rows()).find((d) => d.id === deviceId)!;

    // The Windows name arrives with the check-in; the Owner's name is kept apart.
    await pc.heartbeat(id, { hostname: 'KASSA-1' }).expect(200);
    await api(agent).patch(`/control/devices/${id}`, { displayName: 'Asosiy kassa' }).expect(200);
    await pc.heartbeat(id, { hostname: 'KASSA-2' }).expect(200);
    expect(await row(id)).toMatchObject({ displayName: 'Asosiy kassa', hostname: 'KASSA-2' });
    const oldDeviceId = (await row(id)).deviceId;
    expect(oldDeviceId).toBeTruthy();

    // An old agent can do neither remote action.
    const refused = await api(agent).post(`/control/devices/${id}/reset-id`).expect(409);
    expect(refused.body.code).toBe('AGENT_UNAVAILABLE');
    await api(agent).post(`/control/devices/${id}/rename-host`, { name: 'KASSA-3' }).expect(409);

    // Windows name through the agent: invalid names refused; the answer comes back.
    await pc
      .heartbeat(id, { hostname: 'KASSA-2', capabilities: ['rekey', 'rename_host'] })
      .expect(200);
    await api(agent).post(`/control/devices/${id}/rename-host`, { name: 'bad name!' }).expect(400);
    const asked = await api(agent)
      .post(`/control/devices/${id}/rename-host`, { name: 'KASSA-3' })
      .expect(200);
    await pc
      .heartbeat(id, {
        capabilities: ['rekey', 'rename_host'],
        hostRename: { id: asked.body.requestId, status: 'DONE' },
      })
      .expect(200);
    expect((await row(id)).hostRename).toMatchObject({ name: 'KASSA-3', status: 'DONE' });

    // A new Device ID only when the Owner asked for it.
    const fresh = generateIdentity();
    const rekey = () =>
      api(request.agent(ctx.app)).post(
        '/control/device/rekey',
        signed(pc.identity, 'rekey', id, {
          publicKey: fresh.publicKey,
          proof: signValue(fresh.privateKeyPem, {
            type: 'rekey',
            activationId: id,
            publicKey: fresh.publicKey,
          }),
        }),
      );
    await rekey().expect(409);
    await api(agent).post(`/control/devices/${id}/reset-id`).expect(200);
    const renewed = await rekey().expect(200);
    const newId = renewed.body.activationId as string;
    expect((await row(id)).status).toBe('REPLACED');
    const waiting = await row(newId);
    expect(waiting).toMatchObject({ status: 'PENDING', displayName: 'Asosiy kassa' });
    expect(waiting.deviceId).not.toBe(oldDeviceId);
    const grantOf = async () => {
      const beat = await api(request.agent(ctx.app))
        .post('/control/device/heartbeat', signed(fresh, 'heartbeat', newId, {}))
        .expect(200);
      const body = verifyDocument<{ grant: string }>(beat.body.response, [server.publicKey])!;
      return readGrant(body.grant, [server.publicKey])!;
    };
    expect((await grantOf()).status).toBe('BLOCKED');
    await api(agent).post(`/control/devices/${newId}/approve`).expect(200);
    expect((await grantOf()).status).toBe('ACTIVE');

    // Old device: never back by itself; "Qayta ulash" waits for approval (and the
    // licence limit holds); then removed from the list without touching data.
    await api(agent).post(`/control/devices/${id}/reconnect`).expect(200);
    expect((await row(id)).status).toBe('PENDING');
    const limit = await api(agent).post(`/control/devices/${id}/approve`).expect(409);
    expect(limit.body.code).toBe('ACTIVATION_LIMIT');
    await api(agent).post(`/control/devices/${id}/reject`).expect(200);
    expect((await row(id)).status).toBe('REVOKED');
    await api(agent).post(`/control/devices/${newId}/archive`).expect(409);
    await api(agent).post(`/control/devices/${id}/archive`).expect(200);
    expect((await rows()).map((d) => d.id)).not.toContain(id);
    expect((await rows(true)).map((d) => d.id)).toContain(id);
    expect(await ctx.db.controlLicense.count({ where: { id: lic.licenseId } })).toBe(1);

    const actions = (
      await ctx.db.controlAuditLog.findMany({
        where: { customerId: lic.customerId },
        select: { action: true },
      })
    ).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'device.rename',
        'device.hostname.changed',
        'device.hostname.rename_request',
        'device.hostname.rename_done',
        'device.reset_id.request',
        'device.reset_id',
        'device.approve',
        'device.reconnect',
        'device.reject',
        'device.archive',
      ]),
    );
  });

  it('a reinstall with a new key (data folder deleted) keeps one registry entry', async () => {
    const guest = request.agent(ctx.app);
    const first = registration(guest);
    const sent = first.send({ installedAt: '2026-01-05T10:00:00.000Z', deviceName: 'OSHXONA-PC' });
    expect([200, 201]).toContain((await sent.res).status);
    const again = registration(guest);
    const second = await again.send({
      installedAt: '2026-01-05T10:00:00.000Z',
      deviceName: 'OSHXONA-PC',
    }).res;
    expect([200, 201]).toContain(second.status);
    expect(
      await ctx.db.controlRegistration.count({
        where: { label: 'OSHXONA-PC', installedAt: new Date('2026-01-05T10:00:00.000Z') },
      }),
    ).toBe(1);
  });
});

describe('Owner workflows (Ish rejimlari)', () => {
  it('checks, activates as versions, rolls back and reaches the restaurant by heartbeat', async () => {
    const { agent } = await signedIn();
    const lic = await createLicensedCustomer(agent);
    const pc = device(request.agent(ctx.app));
    const id = (await pc.activate(lic.key).expect(201)).body.activationId as string;
    await pc.heartbeat(id, { capabilities: ['workflow'], facts: { stations: [], staff: { cashier: 1, waiter: 1, kitchen: 1 } } }).expect(200);
    const base = `/control/customers/${lic.customerId}/workflow`;
    const start = await api(agent).get(base).expect(200);
    expect(start.body.active).toBeNull();
    expect(start.body.presets).toHaveLength(20);
    const fastFood = start.body.presets.find((p: { id: number }) => p.id === 2).config;
    const checked = await api(agent).post(`${base}/preview`, { config: fastFood }).expect(200);
    expect(checked.body.routes[0].steps.join(' → ')).toContain('To‘lov');
    // Activation needs explicit confirmation.
    await api(agent).post(base, { config: fastFood }).expect(400);
    const v1 = await api(agent).post(base, { config: fastFood, confirm: true }).expect(201);
    expect(v1.body.version).toBe(1);
    const table = start.body.presets.find((p: { id: number }) => p.id === 7).config;
    await api(agent).post(base, { config: table, confirm: true }).expect(201);
    const back = await api(agent).post(`${base}/rollback`, { version: 1, confirm: true }).expect(201);
    expect(back.body.version).toBe(3);
    const now = await api(agent).get(base).expect(200);
    expect(now.body.active.version).toBe(3);
    expect(now.body.active.config.preset).toBe(2);
    expect(now.body.history.map((h: { version: number }) => h.version)).toEqual([3, 2, 1]);
    // The signed heartbeat answer carries the active workflow.
    const beat = await pc.heartbeat(id).expect(200);
    const doc = verifyDocument<{ workflow: { version: number } }>(beat.body.response, [server.publicKey])!;
    expect(doc.workflow.version).toBe(3);
    const actions = (
      await ctx.db.controlAuditLog.findMany({ where: { customerId: lic.customerId }, select: { action: true } })
    ).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['workflow.activate', 'workflow.rollback']));
  });
});
