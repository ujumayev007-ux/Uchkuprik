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
const patch = (agent: Agent, path: string, body: object = {}) =>
  agent.patch(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

// Smallest valid PNG (1×1 transparent pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function setup() {
  const tenant = await createTenant(ctx);
  const tenantId = tenant.tenant.id;
  await addUser(ctx, tenantId, {
    username: 'kassir',
    roleIds: [tenant.roleId('cashier')],
  });
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const staff = ctx.agent();
  await login(staff, tenant.slug, 'kassir').expect(200);
  const branchId = tenant.branch.id;
  return { tenant, tenantId, owner, staff, branchId };
}

const upload = (agent: Agent, body: Buffer, type = 'image/png') =>
  agent
    .post('/api/operations/evidence')
    .set('Origin', ORIGIN)
    .set('Content-Type', type)
    .send(body);

describe('operations and food safety', () => {
  it('runs checklists with photo evidence and manager approval', async () => {
    const s = await setup();
    const template = await post(s.owner, '/operations/checklist-templates', {
      name: 'Ochilish',
      kind: 'OPENING',
      items: [
        { label: 'Qo‘llarni yuvish stansiyasi', requiresPhoto: false },
        { label: 'Vitrina tozaligi', requiresPhoto: true },
      ],
    }).expect(201);
    await post(s.staff, '/operations/checklist-templates', {
      name: 'Ruxsatsiz',
      kind: 'OTHER',
      items: [{ label: 'x' }],
    }).expect(403);

    const started = await post(
      s.staff,
      `/operations/checklists/${template.body.id}/start`,
      { branchId: s.branchId },
    ).expect(201);
    const runId = started.body.run.id;
    // Starting again returns the same run for the day.
    const again = await post(
      s.staff,
      `/operations/checklists/${template.body.id}/start`,
      { branchId: s.branchId },
    ).expect(201);
    expect(again.body.run.id).toBe(runId);

    await patch(s.staff, `/operations/checklist-runs/${runId}/items/0`, {
      done: true,
    }).expect(200);
    await patch(s.staff, `/operations/checklist-runs/${runId}/items/1`, {
      done: true,
    }).expect(200);
    const incomplete = await post(
      s.staff,
      `/operations/checklist-runs/${runId}/complete`,
    );
    expect(incomplete.body.code).toBe('CHECKLIST_INCOMPLETE');

    // Evidence: real image bytes only, whatever the declared type.
    const fake = await upload(
      s.staff,
      Buffer.from('<script>alert(1)</script>'),
    );
    expect(fake.status).toBe(400);
    const photo = await upload(s.staff, PNG).expect(201);
    const image = await s.owner
      .get(`/api/operations/evidence/${photo.body.id}`)
      .expect(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    await patch(s.staff, `/operations/checklist-runs/${runId}/items/1`, {
      done: true,
      evidenceId: photo.body.id,
    }).expect(200);
    await post(s.staff, `/operations/checklist-runs/${runId}/complete`).expect(
      200,
    );
    expect(
      (
        await patch(s.staff, `/operations/checklist-runs/${runId}/items/0`, {
          done: false,
        })
      ).body.code,
    ).toBe('CHECKLIST_CLOSED');
    await post(s.staff, `/operations/checklist-runs/${runId}/approve`).expect(
      403,
    );
    await post(s.owner, `/operations/checklist-runs/${runId}/approve`).expect(
      200,
    );

    const today = await s.staff
      .get(`/api/operations/checklists?branchId=${s.branchId}`)
      .expect(200);
    expect(today.body.checklists[0].run.status).toBe('APPROVED');

    // Evidence from another tenant is invisible.
    const other = await setup();
    await other.owner
      .get(`/api/operations/evidence/${photo.body.id}`)
      .expect(404);
  });

  it('opens incidents for out-of-range temperatures and requires CAPA to close', async () => {
    const s = await setup();
    const ok = await post(s.staff, '/operations/temperatures', {
      branchId: s.branchId,
      point: 'Muzlatgich 1',
      value: 3.5,
      minValue: 0,
      maxValue: 5,
    }).expect(201);
    expect(ok.body.outOfRange).toBe(false);
    const alarm = await post(s.staff, '/operations/temperatures', {
      branchId: s.branchId,
      point: 'Muzlatgich 1',
      value: 9,
      minValue: 0,
      maxValue: 5,
    }).expect(201);
    expect(alarm.body.outOfRange).toBe(true);
    expect(alarm.body.incidentId).toBeTruthy();
    await expect(
      ctx.db.temperatureLog.delete({ where: { id: ok.body.id } }),
    ).rejects.toThrow();

    const incidentId = alarm.body.incidentId;
    await patch(s.staff, `/operations/incidents/${incidentId}`, {
      status: 'RESOLVED',
    }).expect(403);
    expect(
      (
        await patch(s.owner, `/operations/incidents/${incidentId}`, {
          status: 'CLOSED',
          rootCause: 'Eshik ochiq qolgan',
          correctiveAction: 'Mahsulotlar tekshirildi',
        })
      ).body.code,
    ).toBe('INCIDENT_NOT_RESOLVED');
    expect(
      (
        await patch(s.owner, `/operations/incidents/${incidentId}`, {
          status: 'RESOLVED',
        })
      ).body.code,
    ).toBe('CAPA_REQUIRED');
    await patch(s.owner, `/operations/incidents/${incidentId}`, {
      status: 'RESOLVED',
      rootCause: 'Eshik ochiq qolgan',
      correctiveAction: 'Mahsulotlar tekshirildi, harorat tiklandi',
      preventiveAction: 'Eshik signalizatsiyasi o‘rnatiladi',
    }).expect(200);
    await patch(s.owner, `/operations/incidents/${incidentId}`, {
      status: 'CLOSED',
    }).expect(200);

    const summary = await s.owner
      .get(`/api/operations/summary?branchId=${s.branchId}`)
      .expect(200);
    expect(summary.body).toMatchObject({
      openIncidents: 0,
      temperatureAlarms24h: 1,
    });
  });

  it('handles handovers, recurring tasks and SOP versions', async () => {
    const s = await setup();
    const handover = await post(s.staff, '/operations/handovers', {
      branchId: s.branchId,
      notes: 'Kassa topshirildi, fritur moyi almashtirilishi kerak',
    }).expect(201);
    expect(
      (
        await post(
          s.staff,
          `/operations/handovers/${handover.body.id}/acknowledge`,
        )
      ).body.code,
    ).toBe('SELF_APPROVAL');
    await post(
      s.owner,
      `/operations/handovers/${handover.body.id}/acknowledge`,
    ).expect(200);
    await post(
      s.owner,
      `/operations/handovers/${handover.body.id}/acknowledge`,
    ).expect(409);

    const task = await post(s.owner, '/operations/tasks', {
      branchId: s.branchId,
      title: 'Fritur moyini almashtirish',
      dueAt: new Date(Date.now() - 3_600_000).toISOString(),
      recurrence: 'DAILY',
      requiresPhoto: true,
    }).expect(201);
    expect(
      (await post(s.staff, `/operations/tasks/${task.body.id}/complete`)).body
        .code,
    ).toBe('PHOTO_REQUIRED');
    const photo = await upload(s.staff, PNG).expect(201);
    const done = await post(
      s.staff,
      `/operations/tasks/${task.body.id}/complete`,
      { evidenceId: photo.body.id },
    ).expect(200);
    expect(done.body.nextTaskId).toBeTruthy();
    const open = await s.staff
      .get(`/api/operations/tasks?branchId=${s.branchId}`)
      .expect(200);
    expect(open.body.tasks).toHaveLength(1);
    expect(new Date(open.body.tasks[0].dueAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const sop = await post(s.owner, '/operations/sops', {
      title: 'Qo‘l yuvish',
      category: 'Gigiyena',
      body: '1. Suv bilan namlang.',
    }).expect(201);
    const updated = await put(s.owner, `/operations/sops/${sop.body.id}`, {
      title: 'Qo‘l yuvish',
      category: 'Gigiyena',
      body: '1. Iliq suv bilan namlang.\n2. 20 soniya sovunlang.',
    }).expect(200);
    expect(updated.body.version).toBe(2);
    const revisions = await s.owner
      .get(`/api/operations/sops/${sop.body.id}/revisions`)
      .expect(200);
    expect(
      revisions.body.revisions.map((r: { version: number }) => r.version),
    ).toEqual([2, 1]);
    const list = await s.staff.get('/api/operations/sops').expect(200);
    expect(list.body.sops[0].body).toContain('20 soniya');
  });

  it('traces lots, recalls them across branches and gates by plan', async () => {
    const s = await setup();
    const second = await post(s.owner, '/branches', {
      code: 'yunusobod',
      name: 'Yunusobod',
    }).expect(201);
    const item = await ctx.db.stockItem.create({
      data: { tenantId: s.tenantId, name: 'Tovuq filesi', baseUnit: 'G' },
    });
    const a = await post(s.owner, '/operations/batches', {
      branchId: s.branchId,
      stockItemId: item.id,
      lotNumber: 'LOT-777',
      expiresAt: '2030-01-01',
      quantity: 5000,
    }).expect(201);
    await post(s.owner, '/operations/batches', {
      branchId: second.body.id,
      stockItemId: item.id,
      lotNumber: 'LOT-777',
      quantity: 3000,
    }).expect(201);

    await post(s.staff, `/operations/batches/${a.body.id}/status`, {
      status: 'QUARANTINED',
      reason: 'Hid shubhali',
    }).expect(403);
    await post(s.owner, `/operations/batches/${a.body.id}/status`, {
      status: 'QUARANTINED',
      reason: 'Hid shubhali',
    }).expect(200);
    await post(s.owner, `/operations/batches/${a.body.id}/status`, {
      status: 'RECALLED',
      reason: 'Yetkazib beruvchi qaytarib olish e’lon qildi',
    }).expect(200);
    const recalled = await s.owner
      .get('/api/operations/batches?lot=lot-777')
      .expect(200);
    expect(
      recalled.body.batches.map((b: { status: string }) => b.status),
    ).toEqual(['RECALLED', 'RECALLED']);
    expect(
      (
        await post(s.owner, `/operations/batches/${a.body.id}/status`, {
          status: 'ACTIVE',
          reason: 'Qaytarish',
        })
      ).body.code,
    ).toBe('BATCH_STATUS_INVALID');

    await ctx.db.product.create({
      data: {
        tenantId: s.tenantId,
        categoryId: (
          await ctx.db.menuCategory.create({
            data: { tenantId: s.tenantId, name: 'Taomlar' },
          })
        ).id,
        name: 'Sendvich',
        allergens: ['gluten', 'sut'],
      },
    });
    const matrix = await s.staff.get('/api/operations/allergens').expect(200);
    expect(matrix.body.allergens).toEqual(['gluten', 'sut']);

    const basic = await ctx.db.plan.findUniqueOrThrow({
      where: { code: 'BASIC' },
    });
    await ctx.db.subscription.create({
      data: {
        tenantId: s.tenantId,
        planId: basic.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    expect((await s.owner.get('/api/operations/sops')).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });
});
