import { afterAll, describe, expect, it } from 'vitest';
import { runMaintenanceScheduler } from '../src/modules/assets/assets.routes.js';
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
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);
const today = () => new Date().toISOString().slice(0, 10);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  await addUser(ctx, tenantId, {
    username: 'admin2',
    roleIds: [tenant.roleId('admin')],
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const staff = ctx.agent();
  await login(staff, tenant.slug, 'kassir').expect(200);
  const admin = ctx.agent();
  await login(admin, tenant.slug, 'admin2').expect(200);
  return { tenant, tenantId, owner, staff, admin, branchId: tenant.branch.id };
}

async function asset(s: Awaited<ReturnType<typeof setup>>, tag = 'FRY-01') {
  const created = await post(s.admin, '/assets', {
    branchId: s.branchId,
    tag,
    name: 'Fritur',
    category: 'Oshxona uskunasi',
    purchaseCost: 12_000_000,
    warrantyUntil: '2030-12-31',
  }).expect(201);
  return created.body.id as string;
}

describe('assets and maintenance', () => {
  it('registers assets, finds them by QR tag and records lifecycle history', async () => {
    const s = await setup();
    const id = await asset(s);
    await post(s.staff, '/assets', {
      branchId: s.branchId,
      tag: 'X-1',
      name: 'Ruxsatsiz',
      category: 'x',
    }).expect(403);
    expect(
      (
        await post(s.admin, '/assets', {
          branchId: s.branchId,
          tag: 'fry-01',
          name: 'Takror',
          category: 'Oshxona',
        })
      ).status,
    ).toBe(409);
    const found = await s.staff.get('/api/assets/by-tag/fry-01').expect(200);
    expect(found.body.id).toBe(id);

    const check = await post(s.staff, `/assets/${id}/safety-checks`, {
      passed: false,
      note: 'Termostat ishlamayapti',
    }).expect(201);
    expect(check.body.incidentId).toBeTruthy();

    const detail = await s.staff.get(`/api/assets/${id}`).expect(200);
    expect(detail.body.warrantyActive).toBe(true);
    expect(
      detail.body.asset.events.map((event: { type: string }) => event.type),
    ).toEqual(['SAFETY_CHECK', 'CREATED']);
    const events = await ctx.db.assetEvent.findMany({ where: { assetId: id } });
    await expect(
      ctx.db.assetEvent.delete({ where: { id: events[0]!.id } }),
    ).rejects.toThrow();

    // Another tenant cannot see the asset.
    const other = await setup();
    await other.owner.get(`/api/assets/${id}`).expect(404);
    await other.owner.get('/api/assets/by-tag/FRY-01').expect(404);
  });

  it('requires approval for expensive repairs and restores the asset', async () => {
    const s = await setup();
    const id = await asset(s);
    const ticket = await post(s.staff, `/assets/${id}/tickets`, {
      title: 'Fritur qizimayapti',
      description: 'Ertalabdan beri ishlamayapti',
      priority: 'URGENT',
    }).expect(201);
    expect(
      (await ctx.db.asset.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('IN_REPAIR');
    await patch(s.staff, `/repair-tickets/${ticket.body.id}`, {
      status: 'DONE',
    }).expect(403);

    const close = {
      status: 'DONE',
      technician: 'Servis markazi',
      laborCost: 400_000,
      parts: [{ name: 'Termostat', quantity: 1, cost: 900_000 }],
      resolution: 'Termostat almashtirildi',
    };
    const needs = await patch(
      s.admin,
      `/repair-tickets/${ticket.body.id}`,
      close,
    );
    expect(needs.body.code).toBe('APPROVAL_REQUIRED');
    const approvalId = needs.body.details.approvalId;

    // The requester cannot approve; the owner can (with step-up from login).
    expect(
      (
        await post(s.admin, `/approvals/${approvalId}/decide`, {
          decision: 'APPROVED',
        })
      ).body.code,
    ).toBe('SELF_APPROVAL');
    const pending = await s.owner.get('/api/approvals').expect(200);
    expect(pending.body.approvals[0]).toMatchObject({
      type: 'REPAIR_COST',
      amount: 1_300_000,
    });
    await post(s.owner, `/approvals/${approvalId}/decide`, {
      decision: 'APPROVED',
    }).expect(200);
    await patch(s.admin, `/repair-tickets/${ticket.body.id}`, close).expect(
      200,
    );

    const detail = await s.admin.get(`/api/assets/${id}`).expect(200);
    expect(detail.body.asset.status).toBe('ACTIVE');
    expect(detail.body.maintenanceCost).toBe(1_300_000);
    expect(detail.body.asset.events[0]).toMatchObject({
      type: 'REPAIR_CLOSED',
      cost: 1_300_000,
    });
    // A cheap repair closes without approval.
    const small = await post(s.staff, `/assets/${id}/tickets`, {
      title: 'Tutqich bo‘shagan',
      description: 'Mahkamlash kerak',
    }).expect(201);
    await patch(s.admin, `/repair-tickets/${small.body.id}`, {
      status: 'DONE',
      laborCost: 50_000,
      resolution: 'Mahkamlandi',
    }).expect(200);
  });

  it('turns due maintenance plans into tasks and advances them on completion', async () => {
    const s = await setup();
    const id = await asset(s);
    await post(s.admin, `/assets/${id}/plans`, {
      title: 'Moyni almashtirish va tozalash',
      intervalDays: 7,
      firstDueAt: today(),
    }).expect(201);
    const first = await runMaintenanceScheduler(ctx.services, s.tenantId);
    expect(first.created).toBe(1);
    const again = await runMaintenanceScheduler(ctx.services, s.tenantId);
    expect(again.created).toBe(0);

    const tasks = await s.staff.get('/api/operations/tasks').expect(200);
    const task = tasks.body.tasks.find((row: { title: string }) =>
      row.title.startsWith('Texnik xizmat: Fritur'),
    );
    expect(task).toBeTruthy();
    await post(s.staff, `/operations/tasks/${task.id}/complete`).expect(200);
    const plan = await ctx.db.maintenancePlan.findFirstOrThrow({
      where: { assetId: id },
    });
    expect(plan.lastDoneAt).not.toBeNull();
    expect(plan.nextDueAt.toISOString().slice(0, 10) > today()).toBe(true);
    const events = await ctx.db.assetEvent.findMany({
      where: { assetId: id, type: 'MAINTENANCE' },
    });
    expect(events).toHaveLength(1);
  });
});

describe('training and certifications', () => {
  it('records certificates with expiry and reports recertification reminders', async () => {
    const s = await setup();
    const course = await post(s.owner, '/training/courses', {
      title: 'Oziq-ovqat gigiyenasi',
      content: 'https://example.com/gigiyena',
      validityDays: 365,
    }).expect(201);
    await post(s.staff, '/training/courses', { title: 'Ruxsatsiz' }).expect(
      403,
    );
    const kassir = await ctx.db.user.findFirstOrThrow({
      where: { tenantId: s.tenantId, username: 'kassir' },
    });
    const old = new Date(Date.now() - 350 * 86_400_000);
    const record = await post(s.owner, '/training/records', {
      courseId: course.body.id,
      userId: kassir.id,
      completedAt: old.toISOString(),
      score: 92,
    }).expect(201);
    expect(new Date(record.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const matrix = await s.owner
      .get('/api/training/matrix?days=30')
      .expect(200);
    expect(matrix.body.reminders).toEqual([
      expect.objectContaining({ userId: kassir.id, status: 'EXPIRING' }),
    ]);
    const owner = matrix.body.users.find(
      (row: { userId: string; name: string }) =>
        row.userId !== kassir.id && row.name === 'Egasi',
    );
    expect(owner.courses[0].status).toBe('MISSING');

    const mine = await s.staff.get('/api/training/me').expect(200);
    expect(mine.body.records[0].course.title).toBe('Oziq-ovqat gigiyenasi');
    await expect(
      ctx.db.trainingRecord.delete({ where: { id: record.body.id } }),
    ).rejects.toThrow();
  });
});
