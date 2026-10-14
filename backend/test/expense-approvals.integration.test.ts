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
// Tashkent business day.
const today = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

describe('expense attachments and approval limits', () => {
  it('holds large expenses for approval and keeps them out of P&L until approved', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const role = await ctx.db.role.create({
      data: {
        tenantId,
        name: 'Hisobchi',
        permissions: ['finance.view', 'finance.manage', 'shifts.manage'],
      },
    });
    await addUser(ctx, tenantId, { username: 'hisobchi', roleIds: [role.id] });
    const clerk = ctx.agent();
    await login(clerk, tenant.slug, 'hisobchi').expect(200);
    await put(owner, '/finance/settings', {
      expenseApprovalLimit: 100000,
    }).expect(200);

    const pdf = Buffer.from('%PDF-1.4\n% test\n');
    const upload = await clerk
      .post('/api/finance/attachments')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/pdf')
      .send(pdf);
    expect(upload.status).toBe(201);
    await clerk
      .post('/api/finance/attachments')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('not a pdf'))
      .expect(400);

    const small = await post(clerk, '/expenses', {
      category: 'Xo‘jalik',
      amount: 50000,
      date: today,
      recipient: 'Bozor',
    }).expect(201);
    expect(small.body.approvalStatus).toBe('APPROVED');
    const big = await post(clerk, '/expenses', {
      category: 'Ta’mir',
      amount: 300000,
      date: today,
      recipient: 'Usta Akmal',
      attachmentId: upload.body.id,
    }).expect(201);
    expect(big.body.approvalStatus).toBe('PENDING');

    const pnl = async () =>
      (
        await owner
          .get(`/api/reports/pnl?from=${today}&to=${today}`)
          .expect(200)
      ).body.expenseTotal;
    expect(await pnl()).toBe(50000);

    const approval = await ctx.db.approvalRequest.findFirstOrThrow({
      where: { tenantId, entityId: big.body.id },
    });
    await post(owner, `/approvals/${approval.id}/decide`, {
      decision: 'APPROVED',
      comment: 'Ok',
    }).expect(200);
    expect(await pnl()).toBe(350000);

    const file = await clerk
      .get(`/api/finance/attachments/${upload.body.id}`)
      .expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    // Cash expenses need the clerk's open register and leave it as a pay-out.
    await post(clerk, '/expenses', {
      category: 'Taksi',
      amount: 20000,
      date: today,
      fromCash: true,
    }).expect(409);
    await post(clerk, '/shifts/open', { openingCash: 100000 }).expect(201);
    await post(clerk, '/expenses', {
      category: 'Taksi',
      amount: 20000,
      date: today,
      fromCash: true,
    }).expect(201);
    expect(
      await ctx.db.cashMovement.count({ where: { tenantId, amount: -20000 } }),
    ).toBe(1);
  });
});
