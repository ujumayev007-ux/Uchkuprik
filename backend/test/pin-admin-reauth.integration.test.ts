import { afterAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/crypto.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
} from './helpers.js';

// FastFood terminal: the administrator signs in by PIN; sensitive actions (adding staff)
// still need the password, entered again in the same PIN session.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('administrator by PIN on a FastFood terminal', () => {
  it('adds staff after entering the password again; a PIN-only cashier can not', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = await ctx.db.user.findFirstOrThrow({
      where: { tenantId, username: 'owner' },
    });
    await ctx.db.user.update({
      where: { id: owner.id },
      data: {
        pinHash: await hashSecret(ctx.services.secrets.pepperPin(owner.id, '9999')),
      },
    });
    const cashier = await addUser(ctx, tenantId, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
      pin: '1111',
    });
    // A cashier with a PIN only (no password).
    await ctx.db.user.update({
      where: { id: cashier.id },
      data: { passwordHash: null },
    });

    // The terminal (open to every role) is registered once with the password.
    const terminal = ctx.agent();
    await login(terminal, tenant.slug, 'owner').expect(200);
    await post(terminal, '/devices/register', {
      branchId: tenant.branch.id,
      name: 'Terminal 1',
      panel: 'OTHER',
    }).expect(201);
    await post(terminal, '/auth/logout').expect(204);

    await post(terminal, '/auth/pin', { userId: owner.id, pin: '9999' }).expect(200);
    const staff = {
      username: 'oshpaz',
      displayName: 'Oshpaz',
      pin: '2222',
      roleIds: [tenant.roleId('kitchen')],
      allBranches: true,
      branchIds: [],
    };
    // Sensitive: the password first.
    const refused = await post(terminal, '/users', staff).expect(403);
    expect(refused.body.code).toBe('REAUTH_REQUIRED');
    await post(terminal, '/auth/reauth', { password: 'wrong-password' }).expect(401);
    await post(terminal, '/auth/reauth', { password: PASSWORD }).expect(200);
    await post(terminal, '/users', staff).expect(201);
    await post(terminal, '/auth/logout').expect(204);

    // The PIN-only cashier has no password to prove.
    await post(terminal, '/auth/pin', { userId: cashier.id, pin: '1111' }).expect(200);
    await post(terminal, '/auth/reauth', { password: PASSWORD }).expect(401);
  });
});
