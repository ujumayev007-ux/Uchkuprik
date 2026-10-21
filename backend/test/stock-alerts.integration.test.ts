import { afterAll, describe, expect, it } from 'vitest';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(async () => {
  await ctx.close();
});

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const item = await post(owner, '/inventory/items', {
    name: 'Un',
    baseUnit: 'G',
    minStock: 1000,
    isActive: true,
    units: [],
  }).expect(201);
  const itemId = item.body.id as string;
  await post(owner, '/inventory/adjustments', {
    type: 'ADJUSTMENT',
    reason: 'Boshlang‘ich qoldiq',
    lines: [{ stockItemId: itemId, quantity: 5000 }],
  }).expect(201);
  await addUser(ctx, tenantId, {
    username: 'oshpaz',
    roleIds: [tenant.roleId('kitchen')],
  });
  const cook = ctx.agent();
  await login(cook, tenant.slug, 'oshpaz').expect(200);
  return { tenant, tenantId, owner, cook, itemId };
}
type S = Awaited<ReturnType<typeof setup>>;

const waste = (s: S, grams: number) =>
  post(s.owner, '/inventory/adjustments', {
    type: 'WASTE',
    reason: 'Isrof (sinov)',
    lines: [{ stockItemId: s.itemId, quantity: grams }],
  }).expect(201);
const restock = (s: S, grams: number) =>
  post(s.owner, '/inventory/adjustments', {
    type: 'ADJUSTMENT',
    reason: 'Kirim (sinov)',
    lines: [{ stockItemId: s.itemId, quantity: grams }],
  }).expect(201);
const active = async (s: S) =>
  (await s.owner.get('/api/inventory/stock-alerts').expect(200)).body
    .alerts as {
    id: string;
    severity: string;
    status: string;
    quantity: string;
    name: string;
  }[];

describe('inventory alerts', () => {
  it('raises one alert when stock crosses the minimum and escalates LOW → CRITICAL → OUT', async () => {
    const s = await setup();
    expect(await active(s)).toHaveLength(0);
    await waste(s, 3000); // 2000 left, enough
    expect(await active(s)).toHaveLength(0);
    await waste(s, 1200); // 800: below 1000, above half
    let alerts = await active(s);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'LOW',
      status: 'OPEN',
      name: 'Un',
    });
    expect(alerts[0]!.quantity).toBe('800');
    await waste(s, 400); // 400: below 500 → critical
    alerts = await active(s);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('CRITICAL');
    await waste(s, 400); // 0 → out of stock
    alerts = await active(s);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('OUT');
  });

  it('acknowledging stops the reminder; the same level stays quiet, a worse level asks again', async () => {
    const s = await setup();
    await waste(s, 4200); // 800 LOW
    const [alert] = await active(s);
    await post(s.owner, `/inventory/stock-alerts/${alert!.id}/ack`).expect(200);
    // Pressing twice is harmless.
    await post(s.owner, `/inventory/stock-alerts/${alert!.id}/ack`).expect(200);
    expect((await active(s))[0]!.status).toBe('ACKNOWLEDGED');
    await waste(s, 100); // 700, still LOW: stays acknowledged, no new alert
    let now = await active(s);
    expect(now).toHaveLength(1);
    expect(now[0]!.status).toBe('ACKNOWLEDGED');
    expect(now[0]!.quantity).toBe('700');
    await waste(s, 300); // 400 → critical: asks again
    now = await active(s);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
  });

  it('replenishing resolves the alert and a later shortage alerts again (history kept)', async () => {
    const s = await setup();
    await waste(s, 4500); // 500
    const first = (await active(s))[0]!;
    await restock(s, 4000); // 4500 → resolved
    expect(await active(s)).toHaveLength(0);
    const history = (
      await s.owner.get('/api/inventory/stock-alerts?scope=history').expect(200)
    ).body.alerts;
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(first.id);
    await waste(s, 3800); // 700 → a new alert
    const next = await active(s);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(first.id);
  });

  it('concurrent stock updates never create duplicate alerts', async () => {
    const s = await setup();
    await Promise.all(
      [900, 900, 900, 900, 900].map((grams) =>
        post(s.owner, '/inventory/adjustments', {
          type: 'WASTE',
          reason: 'Parallel isrof',
          lines: [{ stockItemId: s.itemId, quantity: grams }],
        }),
      ),
    );
    const total = await ctx.db.stockAlert.count({
      where: { tenantId: s.tenantId, status: { not: 'RESOLVED' } },
    });
    expect(total).toBe(1);
  });

  it('changing the minimum re-evaluates; settings control alerting; permissions and tenants are enforced', async () => {
    const s = await setup();
    // 5000 on hand: raising the minimum above it creates an alert at once.
    const edited = await s.owner
      .patch(`/api/inventory/items/${s.itemId}`)
      .set('Origin', ORIGIN)
      .send({
        name: 'Un',
        baseUnit: 'G',
        minStock: 6000,
        isActive: true,
        units: [],
      });
    expect(edited.status).toBe(200);
    expect(await active(s)).toHaveLength(1);
    // Switching alerts off resolves on the next stock change and stops new ones.
    await put(s.cook, '/inventory/stock-alert-settings', {
      enabled: false,
      soundEnabled: true,
      criticalPercent: 50,
      reminderMinutes: 10,
    }).expect(403);
    await s.cook.get('/api/inventory/stock-alerts').expect(403);
    const saved = await put(s.owner, '/inventory/stock-alert-settings', {
      enabled: false,
      soundEnabled: false,
      criticalPercent: 40,
      reminderMinutes: 0,
    }).expect(200);
    expect(saved.body).toMatchObject({
      enabled: false,
      soundEnabled: false,
      criticalPercent: 40,
    });
    await put(s.owner, '/inventory/stock-alert-settings', {
      enabled: true,
      soundEnabled: true,
      criticalPercent: 0,
      reminderMinutes: 10,
    }).expect(400);
    await waste(s, 10);
    expect(await active(s)).toHaveLength(0);
    // Another restaurant can neither see nor acknowledge it.
    const other = await setup();
    const mine = await ctx.db.stockAlert.findMany({
      where: { tenantId: s.tenantId },
    });
    if (mine[0])
      await post(
        other.owner,
        `/inventory/stock-alerts/${mine[0].id}/ack`,
      ).expect(404);
    expect(await active(other)).toHaveLength(0);
  });
});
