import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

// Kitchen screens and TV displays: one PIN on a registered device, then a long session
// bound to that device; cashier terminals keep the short one; revoking ends it.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const maxAgeDays = (res: { headers: Record<string, unknown> }) => {
  const cookies = res.headers['set-cookie'] as string[];
  const session = cookies.find((c) => c.startsWith('ff_session='))!;
  return Number(/Max-Age=(\d+)/.exec(session)![1]) / 86_400;
};

async function terminal(panel: string, username: string, role: string) {
  const tenant = await createTenant(ctx);
  const user = await addUser(ctx, tenant.tenant.id, {
    username,
    roleIds: [tenant.roleId(role)],
    pin: '2468',
  });
  const device = ctx.agent();
  await login(device, tenant.slug, 'owner').expect(200);
  const registered = await post(device, '/devices/register', {
    branchId: tenant.branch.id,
    name: `${panel} 1`,
    panel,
  }).expect(201);
  await post(device, '/auth/logout').expect(204);
  return { tenant, user, device, deviceId: registered.body.id as string };
}

describe('kiosk sessions on registered devices', () => {
  it('kitchen and TV stay signed in for weeks; the cashier does not', async () => {
    const kitchen = await terminal('KITCHEN', 'oshpaz', 'kitchen');
    const pin = await post(kitchen.device, '/auth/pin', {
      userId: kitchen.user.id,
      pin: '2468',
    }).expect(200);
    expect(maxAgeDays(pin)).toBeGreaterThan(29);

    const tv = await terminal('DISPLAY', 'ekran', 'kitchen');
    const staff = (await tv.device.get('/api/pin/device').expect(200)).body
      .staff as { id: string }[];
    expect(staff.map((s) => s.id)).toContain(tv.user.id);
    const tvPin = await post(tv.device, '/auth/pin', {
      userId: tv.user.id,
      pin: '2468',
    }).expect(200);
    expect(maxAgeDays(tvPin)).toBeGreaterThan(29);
    await tv.device.get('/api/queue').expect(200);

    const cashier = await terminal('CASHIER', 'kassir', 'cashier');
    const cashierPin = await post(cashier.device, '/auth/pin', {
      userId: cashier.user.id,
      pin: '2468',
    }).expect(200);
    expect(maxAgeDays(cashierPin)).toBeLessThan(1);
  });

  it('revoking the device ends the long session at once', async () => {
    const kitchen = await terminal('KITCHEN', 'oshpaz', 'kitchen');
    await post(kitchen.device, '/auth/pin', {
      userId: kitchen.user.id,
      pin: '2468',
    }).expect(200);
    await kitchen.device.get('/api/auth/me').expect(200);
    const admin = ctx.agent();
    await login(admin, kitchen.tenant.slug, 'owner').expect(200);
    await post(admin, `/devices/${kitchen.deviceId}/revoke`).expect(200);
    const me = await kitchen.device.get('/api/auth/me');
    expect(me.body?.user ?? null).toBeNull();
  });
});
