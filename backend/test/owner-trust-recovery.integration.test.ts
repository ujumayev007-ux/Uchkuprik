import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import {
  fingerprintOf,
  generateIdentity,
  signValue,
} from '../src/modules/control/keys.js';
import { provisionOwner } from '../src/modules/control/owner-admin.js';
import { createTestContext, ORIGIN, PASSWORD, unique } from './helpers.js';

// Owner sign-in: a computer verified once with the second factor can sign in with the
// password (and its device key) afterwards; recovery works only from such a computer
// and only with the one-time recovery key.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
afterAll(() => ctx.close());

const post = (agent: request.Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

let offset = 0;
const codeFor = (secret: string) => {
  offset += 31_000;
  ctx.clock.offsetMs += 31_000;
  return totpCode(secret, currentStep(Date.now() + ctx.clock.offsetMs));
};

type Device = ReturnType<typeof generateIdentity>;

async function proof(agent: request.Agent, device: Device, email: string) {
  const challenge = (await post(agent, '/control/owner/challenge')).body
    .challenge as string;
  return {
    challenge,
    deviceKey: device.publicKey,
    deviceSignature: signValue(device.privateKeyPem, { challenge, email }),
  };
}

async function signIn(
  agent: request.Agent,
  device: Device,
  email: string,
  password: string,
  extra: { code?: string; trustDevice?: boolean } = {},
) {
  return post(agent, '/control/owner/login', {
    email,
    password,
    deviceLabel: 'Test kompyuter',
    ...(await proof(agent, device, email)),
    ...extra,
  });
}

async function setup() {
  const email = `${unique('owner')}@example.com`;
  const created = await provisionOwner(ctx.db, ctx.services.secrets, {
    email,
    displayName: 'Owner',
    password: PASSWORD,
  });
  const home = generateIdentity();
  const agent = request.agent(ctx.app);
  return { email, secret: created.mfaSecret, home, agent };
}

describe('trusted computer sign-in', () => {
  it('asks for the code until the computer is trusted, then password + device key are enough', async () => {
    const o = await setup();
    // Enrolled with a code but not marked trusted: the next sign-in still needs a code.
    const first = await signIn(o.agent, o.home, o.email, PASSWORD, {
      code: codeFor(o.secret),
    });
    expect(first.status).toBe(200);
    expect(first.body.trusted).toBe(false);
    const again = await signIn(
      request.agent(ctx.app),
      o.home,
      o.email,
      PASSWORD,
    );
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('MFA_REQUIRED');
    // Trusting after a successful code.
    const trusted = await signIn(
      request.agent(ctx.app),
      o.home,
      o.email,
      PASSWORD,
      {
        code: codeFor(o.secret),
        trustDevice: true,
      },
    );
    expect(trusted.body.trusted).toBe(true);
    const agent = request.agent(ctx.app);
    const plain = await signIn(agent, o.home, o.email, PASSWORD);
    expect(plain.status).toBe(200);
    expect(plain.body.trusted).toBe(true);
    expect((await agent.get('/api/control/owner/me')).body).toMatchObject({
      mfaVerified: true,
      deviceTrusted: true,
    });
    // The password is still required, and a wrong code is still refused.
    expect(
      (
        await signIn(
          request.agent(ctx.app),
          o.home,
          o.email,
          'Boshqa-parol-1234',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await signIn(request.agent(ctx.app), o.home, o.email, PASSWORD, {
          code: '000000',
        })
      ).status,
    ).toBe(401);
    // Sensitive actions keep asking for a fresh password + code.
    const sensitive = await post(agent, '/control/owner/recovery/key');
    expect(sensitive.status).toBe(403);
    expect(sensitive.body.code).toBe('REAUTH_REQUIRED');
  });

  it('never trusts another computer by itself', async () => {
    const o = await setup();
    await signIn(o.agent, o.home, o.email, PASSWORD, {
      code: codeFor(o.secret),
      trustDevice: true,
    });
    // A second computer without a code can not sign in (it is not even approved).
    const other = generateIdentity();
    const attempt = await signIn(
      request.agent(ctx.app),
      other,
      o.email,
      PASSWORD,
    );
    expect(attempt.status).toBeGreaterThanOrEqual(401);
    expect(attempt.status).not.toBe(200);
    // Approved by the operator but never verified with a code: still needs the code.
    await ctx.db.controlOwnerDevice.updateMany({
      where: { fingerprint: fingerprintOf(other.publicKey) },
      data: { status: 'APPROVED' },
    });
    const approved = await signIn(
      request.agent(ctx.app),
      other,
      o.email,
      PASSWORD,
    );
    expect(approved.status).toBe(401);
    expect(approved.body.code).toBe('MFA_REQUIRED');
  });
});

describe('recovery from the trusted computer only', () => {
  async function trustedOwner() {
    const o = await setup();
    await signIn(o.agent, o.home, o.email, PASSWORD, {
      code: codeFor(o.secret),
      trustDevice: true,
    });
    await post(o.agent, '/control/owner/reauth', {
      password: PASSWORD,
      code: codeFor(o.secret),
    }).expect(200);
    const made = await post(o.agent, '/control/owner/recovery/key');
    expect(made.status).toBe(200);
    return { ...o, key: made.body.key as string };
  }

  const reset = async (
    device: Device,
    email: string,
    body: Record<string, unknown>,
  ) => {
    const agent = request.agent(ctx.app);
    return post(agent, '/control/owner/recovery/reset', {
      email,
      ...(await proof(agent, device, email)),
      ...body,
    });
  };

  it('makes a one-time key that is stored only as a hash', async () => {
    const o = await trustedOwner();
    expect(o.key).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/);
    const row = await ctx.db.controlOwner.findUniqueOrThrow({
      where: { email: o.email },
    });
    expect(row.recoveryHash).not.toBeNull();
    expect(row.recoveryHash).not.toContain(o.key.replace(/-/g, ''));
    expect(
      (await o.agent.get('/api/control/owner/me')).body.hasRecoveryKey,
    ).toBe(true);
    // An untrusted computer can not even make a key.
    const second = generateIdentity();
    await ctx.db.controlOwnerDevice.create({
      data: {
        ownerId: row.id,
        label: 'Boshqa',
        publicKey: second.publicKey,
        fingerprint: fingerprintOf(second.publicKey),
        status: 'APPROVED',
      },
    });
    const otherAgent = request.agent(ctx.app);
    await signIn(otherAgent, second, o.email, PASSWORD, {
      code: codeFor(o.secret),
    });
    await post(otherAgent, '/control/owner/reauth', {
      password: PASSWORD,
      code: codeFor(o.secret),
    }).expect(200);
    const denied = await post(otherAgent, '/control/owner/recovery/key');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('DEVICE_NOT_TRUSTED');
  });

  it('refuses every other computer, and a wrong key, without changing anything', async () => {
    const o = await trustedOwner();
    const stranger = generateIdentity();
    const foreign = await reset(stranger, o.email, {
      recoveryKey: o.key,
      newPassword: 'Yangi-parol-2026-x',
    });
    expect(foreign.status).toBe(403);
    // Even an approved computer that was never verified with a code is refused.
    const row = await ctx.db.controlOwner.findUniqueOrThrow({
      where: { email: o.email },
    });
    const approvedOnly = generateIdentity();
    await ctx.db.controlOwnerDevice.create({
      data: {
        ownerId: row.id,
        label: 'Tasdiqlangan, ishonchsiz',
        publicKey: approvedOnly.publicKey,
        fingerprint: fingerprintOf(approvedOnly.publicKey),
        status: 'APPROVED',
      },
    });
    expect(
      (
        await reset(approvedOnly, o.email, {
          recoveryKey: o.key,
          newPassword: 'Yangi-parol-2026-x',
        })
      ).status,
    ).toBe(403);
    // The trusted computer with a wrong key.
    const wrong = await reset(o.home, o.email, {
      recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE',
      newPassword: 'Yangi-parol-2026-x',
    });
    expect(wrong.status).toBe(401);
    // Nothing changed: the old password still works.
    expect(
      (await signIn(request.agent(ctx.app), o.home, o.email, PASSWORD)).status,
    ).toBe(200);
  });

  it('resets the password (and optionally the second factor) once, ends sessions, keeps the audit free of secrets', async () => {
    const o = await trustedOwner();
    const newPassword = 'Yangi-parol-2026-x';
    const done = await reset(o.home, o.email, {
      recoveryKey: o.key.toLowerCase(),
      newPassword,
      resetMfa: true,
    });
    expect(done.status).toBe(200);
    expect(done.body.secret).toMatch(/^[A-Z2-7]+$/);
    // Existing sessions ended, the old password is gone, the new one works from this
    // trusted computer without a code (the old authenticator no longer matters).
    expect((await o.agent.get('/api/control/owner/me')).status).toBe(401);
    expect(
      (await signIn(request.agent(ctx.app), o.home, o.email, PASSWORD)).status,
    ).toBe(401);
    const agent = request.agent(ctx.app);
    expect((await signIn(agent, o.home, o.email, newPassword)).status).toBe(
      200,
    );
    // The old authenticator secret no longer works for a step-up; the new one does.
    const oldCode = await post(agent, '/control/owner/reauth', {
      password: newPassword,
      code: codeFor(o.secret),
    });
    expect(oldCode.status).toBe(401);
    await post(agent, '/control/owner/reauth', {
      password: newPassword,
      code: codeFor(done.body.secret),
    }).expect(200);
    // The key worked once.
    const replay = await reset(o.home, o.email, {
      recoveryKey: o.key,
      newPassword: 'Yana-bir-parol-2026',
    });
    expect(replay.status).toBe(401);
    // No secret reached the audit log.
    const owner = await ctx.db.controlOwner.findUniqueOrThrow({
      where: { email: o.email },
    });
    const rows = JSON.stringify(
      await ctx.db.controlAuditLog.findMany({ where: { ownerId: owner.id } }),
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
    for (const secret of [
      newPassword,
      o.key,
      o.key.replace(/-/g, ''),
      done.body.secret,
    ])
      expect(rows).not.toContain(secret);
    expect(rows).toContain('owner.recovery.reset');
  });

  it('locks the account after repeated wrong keys', async () => {
    const o = await trustedOwner();
    for (let i = 0; i < 5; i += 1)
      await reset(o.home, o.email, {
        recoveryKey: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ${i}`,
        newPassword: 'Yangi-parol-2026-x',
      });
    const locked = await reset(o.home, o.email, {
      recoveryKey: o.key,
      newPassword: 'Yangi-parol-2026-x',
    });
    expect(locked.status).toBe(429);
  });
});
