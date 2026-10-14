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

describe('waiter pay, advances and loans', () => {
  it('adds shift pay and commissions, books cash advances and loan repayments', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const waiter = await addUser(ctx, tenantId, {
      username: 'ofitsiant',
      roleIds: [tenant.roleId('waiter')],
    });
    await put(owner, `/hr/employees/${waiter.id}`, {
      payType: 'SHIFT',
      rate: 100000,
      perOrder: 2000,
      perCustomer: 1000,
      salesPercentBp: 500,
    }).expect(200);
    // Two attendance shifts in November.
    const day = new Date('2026-11-03T05:00:00Z');
    await ctx.db.attendanceRecord.createMany({
      data: [0, 1].map((offset) => ({
        tenantId,
        branchId: tenant.branch.id,
        userId: waiter.id,
        clockIn: new Date(day.getTime() + offset * 86_400_000),
        clockOut: new Date(day.getTime() + offset * 86_400_000 + 8 * 3_600_000),
      })),
    });
    // Two completed orders by the waiter (one customer): 100 000 net sales.
    const customer = await ctx.db.customer.create({
      data: { tenantId, phone: '+998901110000' },
    });
    for (const total of [60000, 40000])
      await ctx.db.order.create({
        data: {
          tenantId,
          branchId: tenant.branch.id,
          number: Math.floor(Math.random() * 1e6),
          businessDate: new Date('2026-11-04'),
          type: 'DINE_IN',
          status: 'COMPLETED',
          total,
          subtotal: total,
          createdById: waiter.id,
          customerId: customer.id,
          completedAt: new Date('2026-11-04T10:00:00Z'),
          idempotencyKey: randomUUID(),
        },
      });

    // Cash advances need an open register; they leave the drawer as a cash movement.
    await post(owner, '/payroll/adjustments', {
      userId: waiter.id,
      type: 'ADVANCE',
      amount: 50000,
      date: '2026-11-05',
      reason: 'Avans',
      fromCash: true,
    }).expect(409);
    await post(owner, '/shifts/open', { openingCash: 500000 }).expect(201);
    await post(owner, '/payroll/adjustments', {
      userId: waiter.id,
      type: 'ADVANCE',
      amount: 50000,
      date: '2026-11-05',
      reason: 'Avans',
      fromCash: true,
    }).expect(201);
    const movement = await ctx.db.cashMovement.findFirstOrThrow({
      where: { tenantId, amount: -50000 },
    });
    expect(movement.reason).toContain('Avans');
    for (const [type, amount] of [
      ['LOAN', 300000],
      ['REPAYMENT', 100000],
    ] as const)
      await post(owner, '/payroll/adjustments', {
        userId: waiter.id,
        type,
        amount,
        date: '2026-11-06',
        reason: 'Qarz',
      }).expect(201);
    const loans = await owner.get('/api/payroll/loans').expect(200);
    expect(loans.body.loans).toEqual([{ userId: waiter.id, balance: 200000 }]);

    const period = await post(owner, '/payroll/periods', {
      startDate: '2026-11-01',
      endDate: '2026-11-30',
    }).expect(201);
    const detail = await owner
      .get(`/api/payroll/periods/${period.body.id}`)
      .expect(200);
    const line = detail.body.lines.find(
      (row: { userId: string }) => row.userId === waiter.id,
    );
    // 2 shifts × 100 000 + (2 orders × 2 000 + 1 customer × 1 000 + 5% of 100 000).
    expect(line).toMatchObject({
      baseAmount: 200000,
      commission: 10000,
      advances: 150000,
      total: 60000,
    });
  });
});
