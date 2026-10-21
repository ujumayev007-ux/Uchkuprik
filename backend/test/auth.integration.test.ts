import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import {
  addUser,
  createTenant,
  createTestContext,
  ensurePlatformTenant,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';
import { hashSecret } from '../src/lib/crypto.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => {
  ctx.clock.offsetMs = 0;
});

describe('password authentication', () => {
  it('rejects bad credentials without revealing which part was wrong', async () => {
    const { slug } = await createTenant(ctx);
    const agent = ctx.agent();
    const wrongPassword = await login(agent, slug, 'owner', 'noto-gri-parol-1');
    const unknownUser = await login(agent, slug, 'nobody');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('issues an httpOnly SameSite=Strict session cookie and resolves the user', async () => {
    const { slug } = await createTenant(ctx);
    const agent = ctx.agent();
    const response = await login(agent, slug, 'owner').expect(200);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.username).toBe('owner');
    expect(me.body.permissions).toContain('users.manage');
    expect(JSON.stringify(me.body)).not.toMatch(/hash/i);
  });

  it('locks the account after five failures, even for the correct password', async () => {
    const { slug } = await createTenant(ctx);
    const agent = ctx.agent();
    for (let attempt = 0; attempt < 5; attempt++)
      await login(agent, slug, 'owner', 'noto-gri-parol-1').expect(401);
    const locked = await login(agent, slug, 'owner');
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    ctx.clock.offsetMs = 16 * 60_000;
    await login(agent, slug, 'owner').expect(200);
  });

  it('forces an initial password change and revokes the old session on logout', async () => {
    const { slug } = await createTenant(ctx, { mustChangePassword: true });
    const agent = ctx.agent();
    await login(agent, slug, 'owner').expect(200);
    const blocked = await agent.get('/api/users').expect(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const weak = await agent
      .post('/api/auth/password')
      .set('Origin', ORIGIN)
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.body.code).toBe('WEAK_PASSWORD');
    await agent
      .post('/api/auth/password')
      .set('Origin', ORIGIN)
      .send({ currentPassword: PASSWORD, newPassword: 'Yangi-parol-2026' })
      .expect(200);
    await agent.get('/api/users').expect(200);
    await agent.post('/api/auth/logout').set('Origin', ORIGIN).expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('expires idle sessions', async () => {
    const { slug } = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, slug, 'owner').expect(200);
    ctx.clock.offsetMs = 61 * 60_000;
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects requests from foreign origins before authentication', async () => {
    const { slug } = await createTenant(ctx);
    const response = await ctx
      .agent()
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ tenant: slug, username: 'owner', password: PASSWORD });
    expect(response.status).toBe(403);
  });
});

describe('tenant isolation and authorization', () => {
  it('never exposes or modifies another tenant’s users', async () => {
    const a = await createTenant(ctx);
    const b = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, a.slug, 'owner').expect(200);
    const list = await agent.get('/api/users').expect(200);
    expect(list.body.users.map((user: { id: string }) => user.id)).toEqual([
      a.owner.id,
    ]);
    const patch = await agent
      .patch(`/api/users/${b.owner.id}`)
      .set('Origin', ORIGIN)
      .send({
        displayName: 'Hack',
        roleIds: [],
        allBranches: true,
        branchIds: [],
      });
    expect(patch.status).toBe(404);
    // Assigning another tenant's role is rejected even for an owner.
    const cross = await agent
      .post('/api/users')
      .set('Origin', ORIGIN)
      .send({
        username: 'cross',
        displayName: 'Cross',
        password: PASSWORD,
        roleIds: [b.roleId('cashier')],
        allBranches: true,
        branchIds: [],
      });
    expect(cross.status).toBe(400);
    const audit = await agent.get('/api/audit-logs').expect(200);
    expect(
      audit.body.entries.every((entry: { actorUserId: string | null }) =>
        [a.owner.id, null].includes(entry.actorUserId),
      ),
    ).toBe(true);
  });

  it('enforces permissions server-side', async () => {
    const tenant = await createTenant(ctx);
    await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'kassir').expect(200);
    await agent.get('/api/users').expect(403);
    await agent.get('/api/audit-logs').expect(403);
    await agent.get('/api/platform/tenants').expect(403);
  });

  it('prevents administrators from escalating beyond their own permissions', async () => {
    const tenant = await createTenant(ctx);
    await addUser(ctx, tenant.tenant.id, {
      username: 'admin',
      roleIds: [tenant.roleId('admin')],
    });
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'admin').expect(200);
    const grantOwner = await agent
      .post('/api/users')
      .set('Origin', ORIGIN)
      .send({
        username: 'newowner',
        displayName: 'New owner',
        password: PASSWORD,
        roleIds: [tenant.roleId('owner')],
        allBranches: true,
        branchIds: [],
      });
    expect(grantOwner.status).toBe(403);
    const editOwner = await agent
      .patch(`/api/users/${tenant.owner.id}`)
      .set('Origin', ORIGIN)
      .send({
        displayName: 'Buzg‘unchi',
        roleIds: [],
        allBranches: true,
        branchIds: [],
      });
    expect(editOwner.status).toBe(403);
    // Admin lacks roles.manage, so role editing is denied outright.
    await agent
      .post('/api/roles')
      .set('Origin', ORIGIN)
      .send({ name: 'Super', permissions: ['finance.view'] })
      .expect(403);
  });

  it('keeps at least one active owner', async () => {
    const tenant = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'owner').expect(200);
    const demote = await agent
      .patch(`/api/users/${tenant.owner.id}`)
      .set('Origin', ORIGIN)
      .send({
        displayName: 'Egasi',
        roleIds: [tenant.roleId('admin')],
        allBranches: true,
        branchIds: [],
      });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('LAST_OWNER');
    await agent
      .post(`/api/users/${tenant.owner.id}/status`)
      .set('Origin', ORIGIN)
      .send({ status: 'DISABLED' })
      .expect(403);
  });

  it('requires recent re-authentication for privileged changes', async () => {
    const tenant = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'owner').expect(200);
    ctx.clock.offsetMs = 6 * 60_000;
    const body = {
      username: 'xodim',
      displayName: 'Xodim',
      password: PASSWORD,
      roleIds: [tenant.roleId('waiter')],
      allBranches: true,
      branchIds: [],
    };
    const stale = await agent
      .post('/api/users')
      .set('Origin', ORIGIN)
      .send(body);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    await agent
      .post('/api/auth/reauth')
      .set('Origin', ORIGIN)
      .send({ password: 'noto-gri-parol-1' })
      .expect(401);
    await agent
      .post('/api/auth/reauth')
      .set('Origin', ORIGIN)
      .send({ password: PASSWORD })
      .expect(200);
    await agent.post('/api/users').set('Origin', ORIGIN).send(body).expect(201);
    const duplicate = await agent
      .post('/api/users')
      .set('Origin', ORIGIN)
      .send(body);
    expect(duplicate.status).toBe(409);
  });

  it('blocks every session of a suspended tenant', async () => {
    const tenant = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, tenant.slug, 'owner').expect(200);
    await ctx.db.tenant.update({
      where: { id: tenant.tenant.id },
      data: { status: 'SUSPENDED' },
    });
    const existing = await agent.get('/api/users');
    expect(existing.body.code).toBe('TENANT_SUSPENDED');
    const fresh = await login(ctx.agent(), tenant.slug, 'owner');
    expect(fresh.body.code).toBe('TENANT_SUSPENDED');
  });
});

describe('multi-factor authentication', () => {
  it('forces platform administrators to enroll and verifies codes without replay', async () => {
    const platform = await ensurePlatformTenant(ctx);
    const username = unique('pa').toLowerCase();
    await ctx.db.user.create({
      data: {
        tenantId: platform.id,
        username,
        displayName: 'Platform',
        isPlatformAdmin: true,
        passwordHash: await hashSecret(PASSWORD),
      },
    });
    const agent = ctx.agent();
    await login(agent, 'platform', username).expect(200);
    const blocked = await agent.get('/api/platform/tenants');
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');
    const setup = await agent
      .post('/api/auth/mfa/setup')
      .set('Origin', ORIGIN)
      .expect(200);
    const secret: string = setup.body.secret;
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\//);
    await agent
      .post('/api/auth/mfa/enable')
      .set('Origin', ORIGIN)
      .send({
        code:
          '000000' === totpCode(secret, currentStep()) ? '111111' : '000000',
      })
      .expect(400);
    await agent
      .post('/api/auth/mfa/enable')
      .set('Origin', ORIGIN)
      .send({ code: totpCode(secret, currentStep()) })
      .expect(200);
    await agent.get('/api/platform/tenants').expect(200);
    const stored = await ctx.db.user.findFirstOrThrow({
      where: { username, tenantId: platform.id },
    });
    expect(stored.mfaSecretEnc).not.toContain(secret);

    // New login requires the second factor; the already-used code is rejected.
    const second = ctx.agent();
    const first = await login(second, 'platform', username).expect(200);
    expect(first.body.mfaRequired).toBe(true);
    const pending = await second.get('/api/platform/tenants');
    expect(pending.body.code).toBe('MFA_REQUIRED');
    const replay = await second
      .post('/api/auth/mfa/verify')
      .set('Origin', ORIGIN)
      .send({ code: totpCode(secret, currentStep()) });
    expect(replay.status).toBe(401);
    ctx.clock.offsetMs = 30_000;
    await second
      .post('/api/auth/mfa/verify')
      .set('Origin', ORIGIN)
      .send({ code: totpCode(secret, currentStep(Date.now() + 30_000)) })
      .expect(200);
    await second.get('/api/platform/tenants').expect(200);
  });
});

describe('device-bound PIN login', () => {
  it('allows PIN login only on a registered device and never for privileged changes', async () => {
    const tenant = await createTenant(ctx);
    const cashier = await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
      pin: '4821',
    });
    // Without a device cookie the PIN endpoints are unavailable.
    const stranger = ctx.agent();
    await stranger.get('/api/pin/device').expect(403);
    await stranger
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cashier.id, pin: '4821' })
      .expect(403);

    const terminal = ctx.agent();
    await login(terminal, tenant.slug, 'owner').expect(200);
    await terminal
      .post('/api/devices/register')
      .set('Origin', ORIGIN)
      .send({ branchId: tenant.branch.id, name: 'Kassa 1' })
      .expect(201);
    await terminal.post('/api/auth/logout').set('Origin', ORIGIN).expect(204);

    const device = await terminal.get('/api/pin/device').expect(200);
    expect(device.body.branch.id).toBe(tenant.branch.id);
    expect(device.body.staff.map((s: { id: string }) => s.id)).toEqual([
      cashier.id,
    ]);
    await terminal
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cashier.id, pin: '0000' })
      .expect(401);
    await terminal
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cashier.id, pin: '4821' })
      .expect(200);
    const me = await terminal.get('/api/auth/me').expect(200);
    expect(me.body.authMethod).toBe('PIN');
    expect(me.body.activeBranchId).toBe(tenant.branch.id);
    // A PIN session cannot step up to privileged operations.
    await terminal
      .post('/api/auth/reauth')
      .set('Origin', ORIGIN)
      .send({ password: PASSWORD })
      .expect(403);

    // Revoking the device ends its PIN sessions immediately.
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const devices = await owner.get('/api/devices').expect(200);
    await owner
      .post(`/api/devices/${devices.body.devices[0].id}/revoke`)
      .set('Origin', ORIGIN)
      .expect(200);
    await terminal.get('/api/auth/me').expect(401);
    await terminal.get('/api/pin/device').expect(403);
  });

  it('lets only staff whose role allows the terminal panel in with a PIN', async () => {
    const tenant = await createTenant(ctx);
    const cashier = await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
      pin: '2468',
    });
    const cook = await addUser(ctx, tenant.tenant.id, {
      username: 'oshpaz',
      roleIds: [tenant.roleId('kitchen')],
      pin: '1357',
    });
    const terminal = ctx.agent();
    await login(terminal, tenant.slug, 'owner').expect(200);
    await terminal
      .post('/api/devices/register')
      .set('Origin', ORIGIN)
      .send({ branchId: tenant.branch.id, name: 'Oshxona 1', panel: 'KITCHEN' })
      .expect(201);
    await terminal.post('/api/auth/logout').set('Origin', ORIGIN).expect(204);

    const device = await terminal.get('/api/pin/device').expect(200);
    expect(device.body.device.panel).toBe('KITCHEN');
    expect(device.body.staff.map((s: { id: string }) => s.id)).toEqual([
      cook.id,
    ]);
    // A correct cashier PIN is still refused on the kitchen terminal.
    await terminal
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cashier.id, pin: '2468' })
      .expect(401);
    await terminal.get('/api/auth/me').expect(401);
    await terminal
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cook.id, pin: '1357' })
      .expect(200);
  });

  it('locks PIN entry after five failures', async () => {
    const tenant = await createTenant(ctx);
    const cashier = await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
      pin: '1357',
    });
    const terminal = ctx.agent();
    await login(terminal, tenant.slug, 'owner').expect(200);
    await terminal
      .post('/api/devices/register')
      .set('Origin', ORIGIN)
      .send({ branchId: tenant.branch.id, name: 'Kassa 2' })
      .expect(201);
    for (let attempt = 0; attempt < 5; attempt++)
      await terminal
        .post('/api/auth/pin')
        .set('Origin', ORIGIN)
        .send({ userId: cashier.id, pin: '9999' })
        .expect(401);
    const locked = await terminal
      .post('/api/auth/pin')
      .set('Origin', ORIGIN)
      .send({ userId: cashier.id, pin: '1357' });
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('audit trail', () => {
  it('records security events and rejects modification of audit rows', async () => {
    const tenant = await createTenant(ctx);
    await login(ctx.agent(), tenant.slug, 'owner').expect(200);
    const row = await ctx.db.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.tenant.id, action: 'auth.login' },
    });
    await expect(
      ctx.db
        .$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row.id}`,
    ).rejects.toThrow();
    await expect(
      ctx.db.$executeRaw`DELETE FROM audit_logs WHERE id = ${row.id}`,
    ).rejects.toThrow();
  });
});
