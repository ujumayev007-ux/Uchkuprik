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
