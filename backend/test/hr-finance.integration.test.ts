import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
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
const iso = (date: Date) => date.toISOString().slice(0, 10);

async function setup() {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  return { tenant, tenantId: tenant.tenant.id, owner };
}

describe('attendance', () => {
  it('allows one open clock-in per person and audited corrections', async () => {
    const s = await setup();
    await addUser(ctx, s.tenantId, {
      username: 'kassir',
      roleIds: [s.tenant.roleId('cashier')],
    });
    const agent = ctx.agent();
    await login(agent, s.tenant.slug, 'kassir').expect(200);
    await post(agent, '/attendance/clock-in').expect(201);
    expect((await post(agent, '/attendance/clock-in')).body.code).toBe(
      'ALREADY_CLOCKED_IN',
    );
    await post(agent, '/attendance/clock-out').expect(200);
    expect((await post(agent, '/attendance/clock-out')).body.code).toBe(
      'NOT_CLOCKED_IN',
    );
    const mine = await agent.get('/api/attendance/me').expect(200);
    expect(mine.body.open).toBeNull();

    await agent
      .get(`/api/attendance?from=${iso(new Date())}&to=${iso(new Date())}`)
      .expect(403);
    const record = mine.body.records[0];
    const clockIn = new Date(Date.now() - 2 * 3_600_000);
    await s.owner
      .patch(`/api/attendance/${record.id}`)
      .set('Origin', ORIGIN)
      .send({
        clockIn,
        clockOut: new Date(clockIn.getTime() + 3_600_000),
        note: 'Chiqishni unutgan',
      })
      .expect(200);
    const list = await s.owner
      .get(`/api/attendance?from=${iso(clockIn)}&to=${iso(new Date())}`)
      .expect(200);
    expect(list.body.records[0]).toMatchObject({
      name: 'kassir',
      minutes: 60,
      correctedById: expect.any(String),
    });
    expect(
      await ctx.db.auditLog.count({
        where: {
          tenantId: s.tenantId,
          action: 'attendance.correct',
          entityId: record.id,
        },
      }),
    ).toBe(1);
  });
});

describe('payroll', () => {
  it('computes hourly pay with overtime, monthly salary and adjustments, then locks on approval', async () => {
    const s = await setup();
    const hourly = await addUser(ctx, s.tenantId, {
      username: 'oshpaz',
      roleIds: [s.tenant.roleId('kitchen')],
    });
    const monthly = await addUser(ctx, s.tenantId, {
      username: 'menejer',
      roleIds: [s.tenant.roleId('admin')],
    });
    await put(s.owner, `/hr/employees/${hourly.id}`, {
      position: 'Oshpaz',
      payType: 'HOURLY',
      rate: 30000,
    }).expect(200);
    await put(s.owner, `/hr/employees/${monthly.id}`, {
      position: 'Menejer',
      payType: 'MONTHLY',
      rate: 3000000,
    }).expect(200);
    // Two working days in October: 9 h (60 min overtime) and 4 h.
    const day1 = new Date('2026-10-05T04:00:00Z');
    const day2 = new Date('2026-10-06T05:00:00Z');
    await ctx.db.attendanceRecord.createMany({
      data: [
        {
          tenantId: s.tenantId,
          branchId: s.tenant.branch.id,
          userId: hourly.id,
          clockIn: day1,
          clockOut: new Date(day1.getTime() + 9 * 3_600_000),
        },
        {
          tenantId: s.tenantId,
          branchId: s.tenant.branch.id,
          userId: hourly.id,
          clockIn: day2,
          clockOut: new Date(day2.getTime() + 4 * 3_600_000),
        },
      ],
    });
    for (const [type, amount] of [
      ['BONUS', 50000],
      ['PENALTY', 10000],
      ['ADVANCE', 100000],
    ] as const)
      await post(s.owner, '/payroll/adjustments', {
        userId: hourly.id,
        type,
        amount,
        date: '2026-10-10',
        reason: 'Oylik hisob',
      }).expect(201);

    const period = await post(s.owner, '/payroll/periods', {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    }).expect(201);
    const detail = await s.owner
      .get(`/api/payroll/periods/${period.body.id}`)
      .expect(200);
    const line = (userId: string) =>
      detail.body.lines.find(
        (row: { userId: string }) => row.userId === userId,
      );
    // Regular 720 min × 30 000/h = 360 000; overtime 60 min × 30 000 × 1.5 = 45 000.
    expect(line(hourly.id)).toMatchObject({
      workedMinutes: 780,
      overtimeMinutes: 60,
      baseAmount: 360000,
      overtimeAmount: 45000,
      bonuses: 50000,
      penalties: 10000,
      advances: 100000,
      total: 345000,
    });
    expect(line(monthly.id)).toMatchObject({
      baseAmount: 3000000,
      total: 3000000,
    });
    expect(
      (
        await post(s.owner, '/payroll/periods', {
          startDate: '2026-10-01',
          endDate: '2026-10-31',
        })
      ).status,
    ).toBe(409);

    await post(s.owner, `/payroll/periods/${period.body.id}/approve`).expect(
      200,
    );
    expect(
      (await post(s.owner, `/payroll/periods/${period.body.id}/recalculate`))
        .body.code,
    ).toBe('PAYROLL_LOCKED');
    await post(s.owner, `/payroll/periods/${period.body.id}/paid`).expect(200);
    const exported = await s.owner
      .get(`/api/payroll/periods/${period.body.id}/export.csv`)
      .expect(200);
    expect(exported.text).toContain(
      'oshpaz;HOURLY;780;60;360000;45000;50000;10000;100000;345000',
    );

    const cashierUser = await addUser(ctx, s.tenantId, {
      username: 'kassir',
      roleIds: [s.tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, s.tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/payroll/periods').expect(403);
    await put(cashier, `/hr/employees/${cashierUser.id}`, {
      payType: 'HOURLY',
      rate: 999999,
    }).expect(403);
  });
});

describe('finance', () => {
  it('reports profit and loss with cost of goods, expenses and payroll', async () => {
    const s = await setup();
    const tenantId = s.tenantId;
    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Burger' },
    });
    const variant = await ctx.db.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        name: 'Standart',
        price: 40000,
        cost: 15000,
      },
    });
    await post(s.owner, '/shifts/open', { openingCash: 0 }).expect(201);
    for (let i = 0; i < 2; i++) {
      const order = await post(s.owner, '/orders', {
        idempotencyKey: randomUUID(),
        type: 'TAKEAWAY',
        items: [{ variantId: variant.id, quantity: 1 }],
      }).expect(201);
      await post(s.owner, `/orders/${order.body.id}/payments`, {
        idempotencyKey: randomUUID(),
        method: 'CARD',
        amount: 40000,
      }).expect(201);
      await post(s.owner, `/orders/${order.body.id}/complete`).expect(200);
    }
    const today = iso(new Date());
    await post(s.owner, '/expenses', {
      category: 'Ijara',
      amount: 10000,
      date: today,
    }).expect(201);
    const report = await s.owner
      .get(`/api/reports/pnl?from=${today}&to=${today}`)
      .expect(200);
    expect(report.body).toMatchObject({
      orders: 2,
      revenue: 80000,
      cogs: 30000,
      grossProfit: 50000,
      expenseTotal: 10000,
      payroll: 0,
      netProfit: 40000,
    });
    expect(report.body.expenses).toEqual([
      { category: 'Ijara', amount: 10000 },
    ]);
    const csvText = (
      await s.owner
        .get(`/api/reports/pnl.csv?from=${today}&to=${today}`)
        .expect(200)
    ).text;
    expect(csvText.startsWith('﻿')).toBe(true);
    expect(csvText).toContain('"Sof foyda";40000');

    const branches = await s.owner
      .get(`/api/reports/branches?from=${today}&to=${today}`)
      .expect(200);
    expect(branches.body.branches[0]).toMatchObject({
      orders: 2,
      sales: 80000,
      averageCheck: 40000,
      grossProfit: 50000,
    });

    // Kitchen metrics: 10 min (on time for a 15-minute default) and 30 min (late).
    const orders = await ctx.db.order.findMany({
      where: { tenantId },
      orderBy: { number: 'asc' },
    });
    const base = new Date();
    await ctx.db.order.update({
      where: { id: orders[0]!.id },
      data: { placedAt: base, readyAt: new Date(base.getTime() + 10 * 60_000) },
    });
    await ctx.db.order.update({
      where: { id: orders[1]!.id },
      data: { placedAt: base, readyAt: new Date(base.getTime() + 30 * 60_000) },
    });
    const kitchen = await s.owner
      .get(`/api/reports/kitchen?from=${today}&to=${today}`)
      .expect(200);
    expect(kitchen.body).toEqual({
      orders: 2,
      averageMinutes: 20,
      lateOrders: 1,
      onTimePercent: 50,
    });

    await addUser(ctx, tenantId, {
      username: 'kassir',
      roleIds: [s.tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, s.tenant.slug, 'kassir').expect(200);
    await cashier.get(`/api/reports/pnl?from=${today}&to=${today}`).expect(403);
    await post(cashier, '/expenses', {
      category: 'X',
      amount: 1,
      date: today,
    }).expect(403);
  });

  it('closes finished months against back-dated changes', async () => {
    const s = await setup();
    const now = new Date();
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
    );
    const month = iso(lastMonth).slice(0, 7);
    const old = await post(s.owner, '/expenses', {
      category: 'Kommunal',
      amount: 5000,
      date: iso(lastMonth),
    }).expect(201);
    expect(
      (await post(s.owner, '/finance/close', { month: iso(now).slice(0, 7) }))
        .status,
    ).toBe(400);
    await post(s.owner, '/finance/close', { month }).expect(201);
    expect((await post(s.owner, '/finance/close', { month })).body.code).toBe(
      'PERIOD_CLOSED',
    );
    expect(
      (
        await post(s.owner, '/expenses', {
          category: 'Kommunal',
          amount: 1,
          date: iso(lastMonth),
        })
      ).body.code,
    ).toBe('PERIOD_CLOSED');
    expect(
      (
        await s.owner
          .delete(`/api/expenses/${old.body.id}`)
          .set('Origin', ORIGIN)
      ).body.code,
    ).toBe('PERIOD_CLOSED');
    const user = await addUser(ctx, s.tenantId, {
      username: 'xodim',
      roleIds: [s.tenant.roleId('waiter')],
    });
    expect(
      (
        await post(s.owner, '/payroll/adjustments', {
          userId: user.id,
          type: 'BONUS',
          amount: 1,
          date: iso(lastMonth),
          reason: 'Kech',
        })
      ).body.code,
    ).toBe('PERIOD_CLOSED');
  });

  it('keeps owners on the full permission catalog even if the stored role is outdated', async () => {
    const s = await setup();
    const ownerRole = await ctx.db.role.findFirstOrThrow({
      where: { tenantId: s.tenantId, systemKey: 'owner' },
    });
    await ctx.db.role.update({
      where: { id: ownerRole.id },
      data: {
        permissions: ownerRole.permissions.filter(
          (key) => key !== 'finance.manage',
        ),
      },
    });
    const agent = ctx.agent();
    await login(agent, s.tenant.slug, 'owner').expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.permissions).toContain('finance.manage');
  });
});
