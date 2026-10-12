import { afterAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../src/lib/crypto.js';
import { currentStep, generateTotpSecret, totpCode } from '../src/lib/totp.js';
import { runBillingCycle } from '../src/modules/billing/lifecycle.js';
import {
  addUser,
  createTenant,
  createTestContext,
  ensurePlatformTenant,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const DAY = 86_400_000;

async function register(planCode = 'BASIC') {
  const slug = unique('r');
  const agent = ctx.agent();
  const response = await post(agent, '/public/register', {
    businessName: `Burger ${slug}`,
    slug,
    branchName: 'Chilonzor',
    ownerName: 'Sardor Aliyev',
    username: 'egasi',
    password: PASSWORD,
    planCode,
    acceptTerms: true,
  });
  expect(response.status).toBe(201);
  const tenant = await ctx.db.tenant.findUniqueOrThrow({ where: { slug } });
  await login(agent, slug, 'egasi').expect(200);
  return { slug, tenant, agent };
}

async function platformAdmin() {
  const platform = await ensurePlatformTenant(ctx);
  const username = unique('pa').toLowerCase();
  const secret = generateTotpSecret();
  await ctx.db.user.create({
    data: {
      tenantId: platform.id,
      username,
      displayName: 'Platforma',
      isPlatformAdmin: true,
      passwordHash: await hashSecret(PASSWORD),
      mfaSecretEnc: ctx.services.secrets.encrypt(secret),
      mfaEnabledAt: new Date(),
    },
  });
  const agent = ctx.agent();
  await login(agent, 'platform', username).expect(200);
  await post(agent, '/auth/mfa/verify', {
    code: totpCode(secret, currentStep()),
  }).expect(200);
  return agent;
}

describe('self-service registration and entitlements', () => {
  it('creates a trial tenant whose plan gates modules on the server', async () => {
    const plans = await ctx.agent().get('/api/public/plans').expect(200);
    expect(plans.body.plans.map((plan: { code: string }) => plan.code)).toEqual(
      expect.arrayContaining(['BASIC', 'PRO', 'ENTERPRISE']),
    );
    const { agent, slug } = await register('BASIC');
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.mustChangePassword).toBe(false);
    expect(me.body.entitlements).toMatchObject({
      planCode: 'BASIC',
      status: 'TRIALING',
      features: [],
    });
    expect(me.body.billing.trialDaysLeft).toBe(14);

    const blocked = await agent.get('/api/inventory/items');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await agent.get('/api/payroll/periods')).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
    // Core modules stay available on every plan.
    await agent.get('/api/orders').expect(200);

    // Public ordering needs the plan feature even when the setting is enabled.
    await ctx.db.tenantProfile.upsert({
      where: {
        tenantId: (await ctx.db.tenant.findUniqueOrThrow({ where: { slug } }))
          .id,
      },
      update: { publicOrdering: true },
      create: {
        tenantId: (await ctx.db.tenant.findUniqueOrThrow({ where: { slug } }))
          .id,
        publicOrdering: true,
      },
    });
    await ctx.agent().get(`/api/public/r/${slug}`).expect(404);

    // Duplicate slugs, weak passwords and missing consent are rejected.
    const duplicate = await post(ctx.agent(), '/public/register', {
      businessName: 'Takror',
      slug,
      branchName: 'Filial',
      ownerName: 'Ism Familiya',
      username: 'egasi',
      password: PASSWORD,
      planCode: 'BASIC',
      acceptTerms: true,
    });
    expect(duplicate.status).toBe(409);
    const weak = await post(ctx.agent(), '/public/register', {
      businessName: 'Zaif',
      slug: unique('w'),
      branchName: 'Filial',
      ownerName: 'Ism Familiya',
      username: 'egasi',
      password: '123',
      planCode: 'BASIC',
      acceptTerms: true,
    });
    expect(weak.body.code).toBe('WEAK_PASSWORD');
    const noConsent = await post(ctx.agent(), '/public/register', {
      businessName: 'Rozisiz',
      slug: unique('n'),
      branchName: 'Filial',
      ownerName: 'Ism Familiya',
      username: 'egasi',
      password: PASSWORD,
      planCode: 'BASIC',
    });
    expect(noConsent.status).toBe(400);
  });

  it('enforces plan limits and lets the owner upgrade or blocks unsafe downgrades', async () => {
    const { agent, tenant } = await register('BASIC');
    const branch = await post(agent, '/branches', {
      code: 'yunusobod',
      name: 'Yunusobod',
    });
    expect(branch.status).toBe(403);
    expect(branch.body.code).toBe('PLAN_LIMIT_REACHED');

    await post(agent, '/billing/plan', {
      planCode: 'PRO',
      billingCycle: 'MONTHLY',
    }).expect(200);
    await post(agent, '/branches', {
      code: 'yunusobod',
      name: 'Yunusobod',
    }).expect(201);
    await agent.get('/api/inventory/items').expect(200);

    const downgrade = await post(agent, '/billing/plan', {
      planCode: 'BASIC',
      billingCycle: 'MONTHLY',
    });
    expect(downgrade.body.code).toBe('PLAN_USAGE_EXCEEDS');

    // Only the owner may change the plan; managers can view billing.
    const roles = await ctx.db.role.findMany({
      where: { tenantId: tenant.id },
    });
    await addUser(ctx, tenant.id, {
      username: 'menejer',
      roleIds: [roles.find((role) => role.systemKey === 'admin')!.id],
    });
    const manager = ctx.agent();
    await login(manager, tenant.slug, 'menejer').expect(200);
    const view = await manager.get('/api/billing').expect(200);
    expect(view.body.isOwner).toBe(false);
    await post(manager, '/billing/plan', {
      planCode: 'ENTERPRISE',
      billingCycle: 'YEARLY',
    }).expect(403);

    const billing = await agent.get('/api/billing').expect(200);
    expect(billing.body.subscription.plan.code).toBe('PRO');
    expect(billing.body.usage.branches).toBe(2);

    // User limit: a tiny custom plan allows the owner plus one more user.
    const tiny = await ctx.db.plan.create({
      data: {
        code: unique('T').toUpperCase().replace(/-/g, '_').slice(0, 20),
        name: 'Tiny',
        monthlyPrice: 0,
        yearlyPrice: 0,
        maxUsers: 3,
        features: [],
        isActive: false,
      },
    });
    await ctx.db.subscription.update({
      where: { tenantId: tenant.id },
      data: { planId: tiny.id },
    });
    const cashier = roles.find((role) => role.systemKey === 'cashier')!.id;
    const create = (username: string) =>
      post(agent, '/users', {
        username,
        displayName: username,
        password: PASSWORD,
        roleIds: [cashier],
        allBranches: true,
        branchIds: [],
      });
    await create('kassir1').expect(201);
    const over = await create('kassir2');
    expect(over.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('keeps tenants without a subscription unrestricted', async () => {
    const legacy = await createTenant(ctx);
    const agent = ctx.agent();
    await login(agent, legacy.slug, 'owner').expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.entitlements.features).toBeNull();
    await agent.get('/api/inventory/items').expect(200);
  });
});

describe('subscription lifecycle', () => {
  it('invoices after the trial, suspends unpaid tenants and restores them on payment', async () => {
    const { tenant, slug } = await register('BASIC');
    const subscription = await ctx.db.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
    });
    const at = (ms: number) => ({
      ...ctx.services,
      now: () => new Date(subscription.trialEndsAt!.getTime() + ms),
    });

    await runBillingCycle(at(3_600_000), { tenantId: tenant.id });
    await runBillingCycle(at(3_600_000), { tenantId: tenant.id });
    let invoices = await ctx.db.invoice.findMany({
      where: { tenantId: tenant.id },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ amount: 290000, status: 'OPEN' });
    expect(
      (
        await ctx.db.subscription.findUniqueOrThrow({
          where: { tenantId: tenant.id },
        })
      ).status,
    ).toBe('ACTIVE');

    await runBillingCycle(at(8 * DAY), { tenantId: tenant.id });
    expect(
      (
        await ctx.db.subscription.findUniqueOrThrow({
          where: { tenantId: tenant.id },
        })
      ).status,
    ).toBe('PAST_DUE');

    await runBillingCycle(at(15 * DAY), { tenantId: tenant.id });
    const suspended = await ctx.db.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
      include: { tenant: true },
    });
    expect(suspended.status).toBe('SUSPENDED');
    expect(suspended.suspendedForBilling).toBe(true);
    expect(suspended.tenant.status).toBe('SUSPENDED');
    const blocked = await login(ctx.agent(), slug, 'egasi');
    expect(blocked.body.code).toBe('TENANT_SUSPENDED');

    const admin = await platformAdmin();
    const list = await admin
      .get('/api/platform/invoices?status=OPEN')
      .expect(200);
    const invoice = list.body.invoices.find(
      (row: { slug: string }) => row.slug === slug,
    );
    expect(invoice.number).toMatch(/^INV-\d{6,}$/);
    await post(admin, `/platform/invoices/${invoice.id}/pay`, {
      reference: 'Bank o‘tkazmasi 145',
    }).expect(200);
    await post(admin, `/platform/invoices/${invoice.id}/pay`, {
      reference: 'Takror',
    }).expect(409);
    invoices = await ctx.db.invoice.findMany({
      where: { tenantId: tenant.id },
    });
    expect(invoices[0]!.status).toBe('PAID');
    const restored = await ctx.db.subscription.findUniqueOrThrow({
      where: { tenantId: tenant.id },
      include: { tenant: true },
    });
    expect(restored.status).toBe('ACTIVE');
    expect(restored.tenant.status).toBe('ACTIVE');
    await login(ctx.agent(), slug, 'egasi').expect(200);
  });

  it('gives platform administrators plans, subscriptions and analytics', async () => {
    const { tenant } = await register('PRO');
    const admin = await platformAdmin();
    const plans = await admin.get('/api/platform/plans').expect(200);
    const pro = plans.body.plans.find(
      (plan: { code: string }) => plan.code === 'PRO',
    );
    await admin
      .put(`/api/platform/plans/${pro.id}`)
      .set('Origin', ORIGIN)
      .send({ ...pro, features: [...pro.features, 'no_such_feature'] })
      .expect(400);
    await admin
      .put(`/api/platform/plans/${pro.id}`)
      .set('Origin', ORIGIN)
      .send({ ...pro })
      .expect(200);
    await post(admin, `/platform/tenants/${tenant.id}/subscription`, {
      planCode: 'ENTERPRISE',
      billingCycle: 'YEARLY',
    }).expect(200);
    const subscriptions = await admin
      .get('/api/platform/subscriptions')
      .expect(200);
    expect(
      subscriptions.body.subscriptions.find(
        (row: { tenantId: string }) => row.tenantId === tenant.id,
      ),
    ).toMatchObject({ planCode: 'ENTERPRISE', billingCycle: 'YEARLY' });
    const analytics = await admin.get('/api/platform/analytics').expect(200);
    expect(analytics.body).toEqual(
      expect.objectContaining({
        mrr: expect.any(Number),
        arpa: expect.any(Number),
        churnRate30d: expect.any(Number),
      }),
    );

    // Business users cannot reach platform billing.
    const owner = (await register('BASIC')).agent;
    await owner.get('/api/platform/analytics').expect(403);
    await owner.get('/api/platform/invoices').expect(403);
  });
});

describe('tenant data export and closure', () => {
  it('exports tenant data without credentials and closes the account on confirmation', async () => {
    const { agent, slug, tenant } = await register('BASIC');
    const exported = await agent.get('/api/tenant/export').expect(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    const data = JSON.parse(exported.text);
    expect(data.format).toBe('fastfood-export');
    expect(data.user).toHaveLength(1);
    expect(data.user[0].passwordHash).toBeUndefined();
    expect(data.user[0].pinHash).toBeUndefined();
    expect(data.branch[0].tenantId).toBe(tenant.id);
    expect(exported.text).not.toContain('scrypt');
    expect(JSON.stringify(data)).not.toContain(PASSWORD);

    const roles = await ctx.db.role.findMany({
      where: { tenantId: tenant.id },
    });
    await addUser(ctx, tenant.id, {
      username: 'admin2',
      roleIds: [roles.find((role) => role.systemKey === 'admin')!.id],
    });
    const nonOwner = ctx.agent();
    await login(nonOwner, slug, 'admin2').expect(200);
    await nonOwner.get('/api/tenant/export').expect(403);
    await post(nonOwner, '/tenant/close', { confirm: slug }).expect(403);

    expect(
      (await post(agent, '/tenant/close', { confirm: 'boshqa' })).body.code,
    ).toBe('CONFIRM_MISMATCH');
    await post(agent, '/tenant/close', { confirm: slug }).expect(200);
    await agent.get('/api/auth/me').expect(401);
    const closed = await ctx.db.tenant.findUniqueOrThrow({
      where: { id: tenant.id },
      include: { subscription: true },
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.subscription!.status).toBe('CANCELLED');
    expect((await login(ctx.agent(), slug, 'egasi')).body.code).toBe(
      'TENANT_SUSPENDED',
    );
  });
});
