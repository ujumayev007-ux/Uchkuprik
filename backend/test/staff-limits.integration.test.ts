import { afterAll, describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/modules/control/keys.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import {
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';

// The Owner caps how many active staff a role may have (cashier 2, waiter unlimited).

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
afterAll(() => ctx.close());

async function restaurant(limits: Record<string, number>) {
  const tenant = await createTenant(ctx);
  const customer = await ctx.db.controlCustomer.create({
    data: { name: unique('Mijoz'), tenantId: tenant.tenant.id },
  });
  await ctx.db.controlPolicy.create({
    data: {
      customerId: customer.id,
      features: { 'staff.limits': { params: limits } },
    },
  });
  clearPolicyCache();
  clearAdminSettingsCache();
  const admin = ctx.agent();
  await login(admin, tenant.slug, 'owner').expect(200);
  const add = (username: string, role: 'cashier' | 'waiter') =>
    admin
      .post('/api/users')
      .set('Origin', ORIGIN)
      .send({
        username,
        displayName: username,
        password: PASSWORD,
        roleIds: [tenant.roleId(role)],
        allBranches: true,
        branchIds: [],
      });
  return { tenant, customer, admin, add };
}

describe('staff limits per role', () => {
  it('caps cashiers at 2 while waiters stay unlimited', async () => {
    const r = await restaurant({ cashier: 2 });
    await r.add('kassir1', 'cashier').expect(201);
    await r.add('kassir2', 'cashier').expect(201);
    const third = await r.add('kassir3', 'cashier');
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('STAFF_LIMIT');
    expect(third.body.details).toMatchObject({ role: 'cashier', max: 2 });
    for (const name of ['ofits1', 'ofits2', 'ofits3', 'ofits4'])
      await r.add(name, 'waiter').expect(201);
  });

  it('frees a seat when a cashier is disabled and blocks re-enabling or role changes beyond the cap', async () => {
    const r = await restaurant({ cashier: 2 });
    const first = (await r.add('kassir1', 'cashier').expect(201)).body.id;
    await r.add('kassir2', 'cashier').expect(201);
    const waiter = (await r.add('ofits1', 'waiter').expect(201)).body.id;
    // A waiter can not become a third cashier.
    const change = await r.admin
      .patch(`/api/users/${waiter}`)
      .set('Origin', ORIGIN)
      .send({
        displayName: 'ofits1',
        roleIds: [r.tenant.roleId('cashier')],
        allBranches: true,
        branchIds: [],
      });
    expect(change.body.code).toBe('STAFF_LIMIT');
    // Editing an existing cashier is never blocked by their own seat.
    await r.admin
      .patch(`/api/users/${first}`)
      .set('Origin', ORIGIN)
      .send({
        displayName: 'Kassir Bir',
        roleIds: [r.tenant.roleId('cashier')],
        allBranches: true,
        branchIds: [],
      })
      .expect(200);
    // Disable one: a new cashier fits; re-enabling the old one then does not.
    await r.admin
      .post(`/api/users/${first}/status`)
      .set('Origin', ORIGIN)
      .send({ status: 'DISABLED' })
      .expect(200);
    await r.add('kassir3', 'cashier').expect(201);
    const back = await r.admin
      .post(`/api/users/${first}/status`)
      .set('Origin', ORIGIN)
      .send({ status: 'ACTIVE' });
    expect(back.body.code).toBe('STAFF_LIMIT');
  });

  it('treats 0 and a missing value as unlimited and ignores the cap when the feature is off', async () => {
    const zero = await restaurant({ cashier: 0 });
    for (const name of ['kassir_a', 'kassir_b', 'kassir_c'])
      await zero.add(name, 'cashier').expect(201);
    const off = await restaurant({ cashier: 1 });
    await ctx.db.controlPolicy.update({
      where: { customerId: off.customer.id },
      data: {
        features: { 'staff.limits': { mode: 'OFF', params: { cashier: 1 } } },
      },
    });
    clearPolicyCache();
    for (const name of ['kassir_a', 'kassir_b'])
      await off.add(name, 'cashier').expect(201);
  });
});
