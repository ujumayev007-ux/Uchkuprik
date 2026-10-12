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

// The previous calendar month (always finished) and its first day.
const now = new Date();
const previous = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
);
const month = previous.toISOString().slice(0, 7);
const firstDay = `${month}-01`;
const midMonth = new Date(`${month}-15T00:00:00.000Z`);

let orderNumber = 1;
async function sale(tenantId: string, branchId: string, total: number) {
  return ctx.db.order.create({
    data: {
      tenantId,
      branchId,
      number: orderNumber++,
      businessDate: midMonth,
      type: 'TAKEAWAY',
      idempotencyKey: randomUUID(),
      status: 'COMPLETED',
      subtotal: total,
      total,
      completedAt: midMonth,
    },
  });
}

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const second = await post(owner, '/branches', {
    code: 'chilonzor',
    name: 'Chilonzor',
  }).expect(201);
  return {
    tenant,
    tenantId,
    owner,
    main: tenant.branch,
    secondId: second.body.id as string,
  };
}

describe('franchise management', () => {
  it('assigns branches, enforces territories and locks active contracts', async () => {
    const s = await setup();
    const partner = await post(s.owner, '/franchise/franchisees', {
      name: 'Samarqand Food MChJ',
      taxId: '305123456',
      phone: '+998 90 123 45 67',
      branchIds: [s.secondId],
    }).expect(201);
    const rival = await post(s.owner, '/franchise/franchisees', {
      name: 'Raqib MChJ',
      branchIds: [s.secondId],
    });
    expect(rival.body.code).toBe('BRANCH_FRANCHISED');
    const other = await post(s.owner, '/franchise/franchisees', {
      name: 'Raqib MChJ',
    }).expect(201);
    const invalid = await post(s.owner, '/franchise/franchisees', {
      name: 'Noto‘g‘ri STIR',
      taxId: '12',
    });
    expect(invalid.status).toBe(400);

    const contract = {
      franchiseeId: partner.body.id,
      number: 'F-001',
      territory: 'Toshkent,  Chilonzor',
      exclusive: true,
      startDate: firstDay,
      royaltyBp: 600,
      marketingFeeBp: 200,
      minimumMonthlyFee: 0,
    };
    const first = await post(s.owner, '/franchise/contracts', contract).expect(
      201,
    );
    await post(
      s.owner,
      `/franchise/contracts/${first.body.id}/activate`,
    ).expect(200);
    const locked = await put(s.owner, `/franchise/contracts/${first.body.id}`, {
      ...contract,
      royaltyBp: 100,
    });
    expect(locked.body.code).toBe('CONTRACT_LOCKED');

    const competing = await post(s.owner, '/franchise/contracts', {
      ...contract,
      franchiseeId: other.body.id,
      number: 'F-002',
      territory: 'toshkent, chilonzor',
      exclusive: false,
    }).expect(201);
    const conflict = await post(
      s.owner,
      `/franchise/contracts/${competing.body.id}/activate`,
    );
    expect(conflict.body.code).toBe('TERRITORY_CONFLICT');

    const branch = await ctx.db.branch.findUniqueOrThrow({
      where: { id: s.secondId },
    });
    expect(branch.franchiseeId).toBe(partner.body.id);
    // Releasing a branch clears the assignment.
    await put(s.owner, `/franchise/franchisees/${partner.body.id}`, {
      name: 'Samarqand Food MChJ',
      status: 'ACTIVE',
      branchIds: [],
    }).expect(200);
    expect(
      (await ctx.db.branch.findUniqueOrThrow({ where: { id: s.secondId } }))
        .franchiseeId,
    ).toBeNull();
  });

  it('calculates royalties from net sales, applies minimum fees and locks issued statements', async () => {
    const s = await setup();
    const partner = await post(s.owner, '/franchise/franchisees', {
      name: 'Buxoro Partner',
      status: 'ACTIVE',
      branchIds: [s.secondId],
    }).expect(201);
    const small = await post(s.owner, '/franchise/franchisees', {
      name: 'Kichik Partner',
    }).expect(201);
    const contract = await post(s.owner, '/franchise/contracts', {
      franchiseeId: partner.body.id,
      number: 'R-1',
      territory: 'Buxoro',
      startDate: firstDay,
      royaltyBp: 500,
      marketingFeeBp: 100,
    }).expect(201);
    await post(
      s.owner,
      `/franchise/contracts/${contract.body.id}/activate`,
    ).expect(200);
    const minimum = await post(s.owner, '/franchise/contracts', {
      franchiseeId: small.body.id,
      number: 'R-2',
      territory: 'Navoiy',
      startDate: firstDay,
      royaltyBp: 500,
      minimumMonthlyFee: 300000,
    }).expect(201);
    await post(
      s.owner,
      `/franchise/contracts/${minimum.body.id}/activate`,
    ).expect(200);

    // Franchised branch: 1 000 000 sold, 100 000 refunded. Company branch is ignored.
    const sold = await sale(s.tenantId, s.secondId, 1_000_000);
    await sale(s.tenantId, s.main.id, 5_000_000);
    const payment = await ctx.db.payment.create({
      data: {
        tenantId: s.tenantId,
        branchId: s.secondId,
        orderId: sold.id,
        method: 'CASH',
        amount: 1_000_000,
        idempotencyKey: randomUUID(),
      },
    });
    const ownerUser = await ctx.db.user.findFirstOrThrow({
      where: { tenantId: s.tenantId, username: 'owner' },
    });
    await ctx.db.refund.create({
      data: {
        tenantId: s.tenantId,
        orderId: sold.id,
        paymentId: payment.id,
        method: 'CASH',
        amount: 100_000,
        reason: 'Mijoz qaytardi',
        approvedById: ownerUser.id,
      },
    });

    const generated = await post(s.owner, '/franchise/statements/generate', {
      month,
    }).expect(200);
    expect(generated.body).toMatchObject({ created: 2, updated: 0, locked: 0 });
    const list = await s.owner
      .get(`/api/franchise/statements?month=${month}`)
      .expect(200);
    const main = list.body.statements.find(
      (row: { contract: { number: string } }) => row.contract.number === 'R-1',
    );
    expect(main).toMatchObject({
      grossSales: 1_000_000,
      refunds: 100_000,
      netSales: 900_000,
      royalty: 45_000,
      marketingFee: 9_000,
      minimumTopUp: 0,
      total: 54_000,
      status: 'DRAFT',
    });
    const topUp = list.body.statements.find(
      (row: { contract: { number: string } }) => row.contract.number === 'R-2',
    );
    expect(topUp).toMatchObject({
      netSales: 0,
      minimumTopUp: 300_000,
      total: 300_000,
    });

    await post(s.owner, `/franchise/statements/${main.id}/issue`).expect(200);
    const again = await post(s.owner, '/franchise/statements/generate', {
      month,
    }).expect(200);
    expect(again.body).toMatchObject({ created: 0, updated: 1, locked: 1 });
    await post(s.owner, `/franchise/statements/${main.id}/paid`, {
      reference: 'To‘lov topshirig‘i 77',
    }).expect(200);
    await post(s.owner, `/franchise/statements/${main.id}/paid`, {
      reference: 'Takror',
    }).expect(409);

    const exported = await s.owner
      .get(`/api/franchise/statements.csv?month=${month}`)
      .expect(200);
    expect(exported.text).toContain('Buxoro Partner');
    expect(exported.text).toContain('54000');

    // Future months cannot be generated.
    const future = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1),
    )
      .toISOString()
      .slice(0, 7);
    await post(s.owner, '/franchise/statements/generate', {
      month: future,
    }).expect(400);
  });

  it('records append-only inspections, scorecards and a scoped franchisee portal', async () => {
    const s = await setup();
    const partner = await post(s.owner, '/franchise/franchisees', {
      name: 'Portal Partner',
      status: 'ACTIVE',
      branchIds: [s.secondId],
    }).expect(201);
    await post(s.owner, '/franchise/franchisees', {
      name: 'Yashirin Partner',
      branchIds: [s.main.id],
    }).expect(201);
    const inspection = await post(s.owner, '/franchise/inspections', {
      branchId: s.secondId,
      inspectedAt: new Date().toISOString(),
      items: [
        { label: 'Oshxona tozaligi', passed: true },
        { label: 'Harorat jurnali', passed: true },
        { label: 'Xodimlar formasi', passed: false, note: 'Qalpoqsiz' },
        { label: 'Brend standartlari', passed: true },
      ],
    }).expect(201);
    expect(inspection.body.score).toBe(75);
    await expect(
      ctx.db.inspection.update({
        where: { id: inspection.body.id },
        data: { score: 100 },
      }),
    ).rejects.toThrow();

    const cards = await s.owner
      .get(`/api/franchise/scorecards?month=${month}`)
      .expect(200);
    expect(
      cards.body.scorecards.find(
        (card: { name: string }) => card.name === 'Portal Partner',
      ),
    ).toMatchObject({ branchCount: 1, averageScore: 75, inspections: 1 });

    // A franchisee user sees only their own partner data and cannot manage.
    await addUser(ctx, s.tenantId, {
      username: 'franchayzi',
      roleIds: [s.tenant.roleId('franchisee')],
      branchIds: [s.secondId],
    });
    const portalUser = ctx.agent();
    await login(portalUser, s.tenant.slug, 'franchayzi').expect(200);
    const portal = await portalUser.get('/api/franchise/portal').expect(200);
    expect(
      portal.body.franchisees.map((f: { name: string }) => f.name),
    ).toEqual(['Portal Partner']);
    expect(portal.body.inspections).toHaveLength(1);
    expect(JSON.stringify(portal.body)).not.toContain('Yashirin Partner');
    await portalUser.get('/api/franchise/franchisees').expect(403);
    await portalUser
      .get(`/api/franchise/scorecards?month=${month}`)
      .expect(403);
    expect(partner.body.id).toBeTruthy();
  });

  it('manages supplier agreements and gates franchise features by plan', async () => {
    const s = await setup();
    const supplier = await ctx.db.supplier.create({
      data: { tenantId: s.tenantId, name: 'Go‘sht Savdo' },
    });
    const agreement = await post(s.owner, '/supplier-agreements', {
      supplierId: supplier.id,
      title: 'Mol go‘shti narx kelishuvi',
      startDate: firstDay,
      paymentTermsDays: 14,
      terms: 'Har hafta yetkazib berish',
    }).expect(201);
    await put(s.owner, `/supplier-agreements/${agreement.body.id}`, {
      supplierId: supplier.id,
      title: 'Mol go‘shti narx kelishuvi',
      startDate: firstDay,
      endDate: '2000-01-01',
    }).expect(400);
    const list = await s.owner.get('/api/supplier-agreements').expect(200);
    expect(list.body.agreements[0]).toMatchObject({
      title: 'Mol go‘shti narx kelishuvi',
      paymentTermsDays: 14,
      supplier: { name: 'Go‘sht Savdo' },
    });

    const pro = await ctx.db.plan.findUniqueOrThrow({ where: { code: 'PRO' } });
    await ctx.db.subscription.create({
      data: {
        tenantId: s.tenantId,
        planId: pro.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const gated = await s.owner.get('/api/franchise/franchisees');
    expect(gated.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await s.owner.get('/api/supplier-agreements')).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });
});
