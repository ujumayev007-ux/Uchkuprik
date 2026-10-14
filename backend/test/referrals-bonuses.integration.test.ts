import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { onOrderCompleted } from '../src/modules/crm/loyalty.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  return { tenant, tenantId: tenant.tenant.id, owner };
}

const completedOrder = (
  tenantId: string,
  branchId: string,
  data: { customerId?: string; createdById?: string; total: number },
) =>
  ctx.db.order.create({
    data: {
      tenantId,
      branchId,
      number: Math.floor(Math.random() * 1e6),
      businessDate: new Date('2026-12-02'),
      type: 'TAKEAWAY',
      status: 'COMPLETED',
      subtotal: data.total,
      total: data.total,
      completedAt: new Date('2026-12-02T10:00:00Z'),
      idempotencyKey: randomUUID(),
      ...(data.customerId ? { customerId: data.customerId } : {}),
      ...(data.createdById ? { createdById: data.createdById } : {}),
    },
  });

describe('loyalty cards and referrals', () => {
  it('issues a scannable card and rewards both sides of a referral once', async () => {
    const s = await setup();
    await put(s.owner, '/settings/loyalty-rules', {
      referrerPoints: 10000,
      referredPoints: 5000,
    }).expect(200);
    const friend = await ctx.db.customer.create({
      data: { tenantId: s.tenantId, phone: '+998901000001' },
    });
    const card = await post(s.owner, `/customers/${friend.id}/card`).expect(
      200,
    );
    expect(card.body.cardCode).toMatch(/^[A-Z2-9]{8}$/);
    // Issuing again returns the same card.
    expect(
      (await post(s.owner, `/customers/${friend.id}/card`)).body.cardCode,
    ).toBe(card.body.cardCode);
    const found = await s.owner
      .get(`/api/customers?q=${card.body.cardCode.toLowerCase()}`)
      .expect(200);
    expect(found.body.customers.map((c: { id: string }) => c.id)).toEqual([
      friend.id,
    ]);

    const newcomer = await ctx.db.customer.create({
      data: { tenantId: s.tenantId, phone: '+998901000002' },
    });
    await post(s.owner, `/customers/${newcomer.id}/referrer`, {
      code: 'WRONG123',
    }).expect(409);
    await post(s.owner, `/customers/${friend.id}/referrer`, {
      code: card.body.cardCode,
    }).expect(409); // cannot refer yourself
    await post(s.owner, `/customers/${newcomer.id}/referrer`, {
      code: card.body.cardCode,
    }).expect(200);
    for (let i = 0; i < 2; i++) {
      const order = await completedOrder(s.tenantId, s.tenant.branch.id, {
        customerId: newcomer.id,
        total: 30000,
      });
      await ctx.db.$transaction((tx) => onOrderCompleted(tx, order.id, null));
    }
    const points = async (id: string) =>
      (await ctx.db.customer.findUniqueOrThrow({ where: { id } })).points;
    expect(await points(friend.id)).toBe(10000);
    expect(await points(newcomer.id)).toBe(5000);
  });
});

describe('team and quality bonuses', () => {
  it('splits a team bonus by sales and adds quality bonuses from ratings', async () => {
    const s = await setup();
    const a = await addUser(ctx, s.tenantId, {
      username: 'ofitsiant1',
      roleIds: [s.tenant.roleId('waiter')],
    });
    const b = await addUser(ctx, s.tenantId, {
      username: 'ofitsiant2',
      roleIds: [s.tenant.roleId('waiter')],
    });
    const orders = [];
    for (const [user, total] of [
      [a.id, 30000],
      [a.id, 30000],
      [a.id, 30000],
      [b.id, 10000],
    ] as const)
      orders.push(
        await completedOrder(s.tenantId, s.tenant.branch.id, {
          createdById: user,
          total,
        }),
      );
    for (const order of orders.slice(0, 3))
      await ctx.db.feedback.create({
        data: {
          tenantId: s.tenantId,
          branchId: s.tenant.branch.id,
          orderId: order.id,
          rating: 5,
        },
      });
    const split = await post(s.owner, '/payroll/team-bonus', {
      userIds: [a.id, b.id],
      amount: 100001,
      split: 'SALES',
      date: '2026-12-03',
      from: '2026-12-01',
      to: '2026-12-31',
      reason: 'Oylik reja bajarildi',
    }).expect(201);
    const share = (id: string) =>
      split.body.shares.find((row: { userId: string }) => row.userId === id)
        .amount;
    expect(share(a.id) + share(b.id)).toBe(100001);
    expect(share(a.id)).toBe(90001);

    await put(s.owner, `/hr/employees/${a.id}`, {
      payType: 'NONE',
      rate: 0,
      qualityBonus: 50000,
      qualityMinRating: 4.5,
    }).expect(200);
    const period = await post(s.owner, '/payroll/periods', {
      startDate: '2026-12-01',
      endDate: '2026-12-31',
    }).expect(201);
    const detail = await s.owner
      .get(`/api/payroll/periods/${period.body.id}`)
      .expect(200);
    const line = detail.body.lines.find(
      (row: { userId: string }) => row.userId === a.id,
    );
    expect(line.bonuses).toBe(90001 + 50000);
  });
});
