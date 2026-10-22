import { afterAll, describe, expect, it } from 'vitest';
import { applyOwnerDecision } from '../src/modules/devices/approval.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Restaurant install (self-hosted): a terminal registered by the restaurant Admin stays
// PENDING until the Owner's signed decision arrives; nothing local can activate it.

const ctx = createTestContext({ selfHosted: true });
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

async function pendingTerminal() {
  const tenant = await createTenant(ctx);
  const cashier = await addUser(ctx, tenant.tenant.id, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
    pin: '1357',
  });
  const terminal = ctx.agent();
  await login(terminal, tenant.slug, 'owner').expect(200);
  const registered = await post(terminal, '/devices/register', {
    branchId: tenant.branch.id,
    name: 'Kassa 2',
    panel: 'CASHIER',
  }).expect(201);
  await post(terminal, '/auth/logout').expect(204);
  return {
    tenant,
    cashier,
    terminal,
    deviceId: registered.body.id as string,
    status: registered.body.status as string,
  };
}

describe('Owner approval of new restaurant terminals', () => {
  it('a new terminal waits for the Owner; the approval makes it work', async () => {
    const t = await pendingTerminal();
    expect(t.status).toBe('PENDING');
    const registerLog = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: t.deviceId, action: 'device.register' },
    });
    expect(JSON.stringify(registerLog.data)).toContain('PENDING');

    // No staff list, no PIN session while pending.
    const info = await t.terminal.get('/api/pin/device').expect(403);
    expect(info.body.code).toBe('DEVICE_PENDING');
    const pin = await post(t.terminal, '/auth/pin', {
      userId: t.cashier.id,
      pin: '1357',
    }).expect(403);
    expect(pin.body.code).toBe('DEVICE_PENDING');
    // The restaurant Admin has no way to activate it (revoke is the only device action).
    const admin = ctx.agent();
    await login(admin, t.tenant.slug, 'owner').expect(200);
    await post(admin, `/devices/${t.deviceId}/revoke`).expect(404);
    const listed = (await admin.get('/api/devices').expect(200)).body.devices;
    expect(listed.find((d: { id: string }) => d.id === t.deviceId).status).toBe(
      'PENDING',
    );

    // The Owner's signed decision (applied by the install runtime).
    expect(
      await applyOwnerDecision(
        ctx.db,
        { id: 'cmd-1', localId: t.deviceId, approve: true },
        new Date(),
      ),
    ).toBe(true);
    const approvedLog = await ctx.db.auditLog.findFirstOrThrow({
      where: { entityId: t.deviceId, action: 'device.owner_approve' },
    });
    expect(JSON.stringify(approvedLog.data)).toContain('cmd-1');
    // A repeated command changes nothing.
    expect(
      await applyOwnerDecision(
        ctx.db,
        { id: 'cmd-1', localId: t.deviceId, approve: false },
        new Date(),
      ),
    ).toBe(false);
    // Same device cookie (also after an IP / Wi-Fi change): works without a new approval.
    const staff = (await t.terminal.get('/api/pin/device').expect(200)).body
      .staff as { id: string }[];
    expect(staff.map((s) => s.id)).toContain(t.cashier.id);
    await post(t.terminal, '/auth/pin', {
      userId: t.cashier.id,
      pin: '1357',
    }).expect(200);
    await t.terminal.get('/api/auth/me').expect(200);
  });

  it('a rejected terminal never works; approved devices are not touched', async () => {
    const t = await pendingTerminal();
    const existing = await ctx.db.device.create({
      data: {
        tenantId: t.tenant.tenant.id,
        branchId: t.tenant.branch.id,
        name: 'Eski kassa',
        tokenHash: `existing-${t.deviceId}`,
        registeredById: t.cashier.id,
      },
    });
    expect(existing.status).toBe('ACTIVE');
    await applyOwnerDecision(
      ctx.db,
      { id: 'cmd-2', localId: t.deviceId, approve: false },
      new Date(),
    );
    const row = await ctx.db.device.findUniqueOrThrow({
      where: { id: t.deviceId },
    });
    expect(row.status).toBe('REVOKED');
    const info = await t.terminal.get('/api/pin/device').expect(403);
    expect(info.body.code).toBe('DEVICE_REQUIRED');
    expect(
      await ctx.db.auditLog.count({
        where: { entityId: t.deviceId, action: 'device.owner_reject' },
      }),
    ).toBe(1);
    // A decision for an already active device is ignored.
    expect(
      await applyOwnerDecision(
        ctx.db,
        { id: 'cmd-3', localId: existing.id, approve: false },
        new Date(),
      ),
    ).toBe(false);
    expect(
      (await ctx.db.device.findUniqueOrThrow({ where: { id: existing.id } }))
        .status,
    ).toBe('ACTIVE');
  });
});
