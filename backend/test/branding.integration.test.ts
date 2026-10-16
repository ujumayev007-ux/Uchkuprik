import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { currentStep, totpCode } from '../src/lib/totp.js';
import { clearBundleCache } from '../src/modules/branding/bundle.js';
import { generateIdentity, signValue } from '../src/modules/control/keys.js';
import { provisionOwner } from '../src/modules/control/owner-admin.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
  cloudViewProvider,
} from '../src/modules/control/view.js';
import { createEventBus } from '../src/realtime/bus.js';
import {
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  PASSWORD,
  unique,
} from './helpers.js';

// Central advertising and remote design: media validation, campaigns, targeting,
// design layers and delegation, tenant isolation, counters, audit and live events.

const server = generateIdentity();
const ctx = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
const bus = createEventBus();
ctx.services.events = bus;
ctx.services.controlView = cloudViewProvider(ctx.db, () => new Date());
afterAll(() => ctx.close());

const png = (extra = 40) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 7),
  ]);
const mp4 = () =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.alloc(40, 3),
  ]);

const api = (agent: request.Agent) => ({
  get: (path: string) => agent.get(`/api${path}`),
  post: (path: string, body: object = {}) =>
    agent.post(`/api${path}`).set('Origin', ORIGIN).send(body),
  put: (path: string, body: object = {}) =>
    agent.put(`/api${path}`).set('Origin', ORIGIN).send(body),
  del: (path: string, body: object = {}) =>
    agent.delete(`/api${path}`).set('Origin', ORIGIN).send(body),
  upload: (path: string, bytes: Buffer, type = 'application/octet-stream') =>
    agent
      .post(`/api${path}`)
      .set('Origin', ORIGIN)
      .set('Content-Type', type)
      .send(bytes),
});

function nextCode(secret: string) {
  ctx.clock.offsetMs += 31_000;
  return totpCode(secret, currentStep(Date.now() + ctx.clock.offsetMs));
}

async function ownerSession() {
  const email = `${unique('owner')}@example.com`;
  const created = await provisionOwner(ctx.db, ctx.services.secrets, {
    email,
    displayName: 'Super Owner',
    password: PASSWORD,
  });
  const agent = request.agent(ctx.app);
  const device = generateIdentity();
  const challenge = (await api(agent).post('/control/owner/challenge')).body
    .challenge as string;
  await api(agent)
    .post('/control/owner/login', {
      email,
      password: PASSWORD,
      challenge,
      deviceKey: device.publicKey,
      deviceSignature: signValue(device.privateKeyPem, { challenge, email }),
      deviceLabel: 'Test EXE',
      code: nextCode(created.mfaSecret),
    })
    .expect(200);
  await api(agent)
    .post('/control/owner/reauth', {
      password: PASSWORD,
      code: nextCode(created.mfaSecret),
    })
    .expect(200);
  return { agent, email };
}

/** A hosted restaurant linked to a customer, with a signed-in Admin. */
async function restaurant(policy: Record<string, unknown> = {}) {
  const tenant = await createTenant(ctx);
  const customer = await ctx.db.controlCustomer.create({
    data: { name: unique('Mijoz'), tenantId: tenant.tenant.id },
  });
  await ctx.db.controlPolicy.create({
    data: { customerId: customer.id, ...policy },
  });
  clearPolicyCache();
  clearAdminSettingsCache();
  clearBundleCache();
  const staff = ctx.agent();
  await login(staff, tenant.slug, 'owner').expect(200);
  return { tenant, customer, staff };
}

const adInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Yangi menyu',
  kind: 'TEXT',
  format: 'BANNER',
  text: 'Bugun barcha burgerlarga 10% chegirma!',
  panels: ['CASHIER', 'ADMIN'],
  targetMode: 'ALL',
  durationSec: 10,
  closable: true,
  status: 'ACTIVE',
  ...overrides,
});

describe('advertising and design media', () => {
  it('accepts only real pictures and videos, judged by their bytes', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    const okPng = await owner.upload('/control/media?name=baner.png', png());
    expect(okPng.status).toBe(201);
    expect(okPng.body.media).toMatchObject({
      kind: 'IMAGE',
      mime: 'image/png',
    });
    expect(
      (await owner.upload('/control/media?name=video.mp4', mp4())).body.media
        .kind,
    ).toBe('VIDEO');
    // Scripts, SVG and HTML are refused even when they claim to be a picture.
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<!doctype html><script>alert(1)</script>',
      'GARBAGE GARBAGE GARBAGE GARBAGE',
    ]) {
      const response = await owner.upload(
        '/control/media?name=x.png',
        Buffer.from(bad),
        'image/png',
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MEDIA_INVALID');
    }
    // Pictures above 3 MB are refused.
    const big = await owner.upload(
      '/control/media?name=big.png',
      png(3_200_000),
    );
    expect(big.status).toBe(413);
    // Delivered with a locked-down response.
    const served = await request(ctx.app).get(
      `/api/branding/media/${okPng.body.media.id}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain('sandbox');
  });

  it('keeps unauthenticated visitors and restaurant staff away from the Owner endpoints', async () => {
    const r = await restaurant();
    for (const [method, path] of [
      ['get', '/control/ads'],
      ['post', '/control/ads'],
      ['get', '/control/design'],
      ['put', '/control/design/global'],
      ['post', '/control/media'],
    ] as const) {
      expect([401, 403]).toContain(
        (await request(ctx.app)[method](`/api${path}`).set('Origin', ORIGIN))
          .status,
      );
      expect([401, 403]).toContain(
        (
          await api(r.staff)[
            method === 'get' ? 'get' : method === 'put' ? 'put' : 'post'
          ](path, {})
        ).status,
      );
    }
  });
});

describe('advertising campaigns', () => {
  it('validates campaigns and keeps them in the audit log', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    // Text needs text; pictures need a picture of the right kind.
    expect(
      (await owner.post('/control/ads', adInput({ text: null }))).status,
    ).toBe(400);
    expect(
      (await owner.post('/control/ads', adInput({ kind: 'IMAGE' }))).status,
    ).toBe(400);
    const video = (await owner.upload('/control/media?name=v.mp4', mp4())).body
      .media;
    expect(
      (
        await owner.post(
          '/control/ads',
          adInput({ kind: 'IMAGE', mediaId: video.id }),
        )
      ).status,
    ).toBe(400);
    // A fullscreen advertisement must be closable or close by itself.
    expect(
      (
        await owner.post(
          '/control/ads',
          adInput({ format: 'FULLSCREEN', closable: false }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.post(
          '/control/ads',
          adInput({ targetMode: 'SELECTED', customerIds: [] }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.post(
          '/control/ads',
          adInput({ targetMode: 'SELECTED', customerIds: [randomUUID()] }),
        )
      ).status,
    ).toBe(400);
    const created = await owner.post(
      '/control/ads',
      adInput({
        format: 'FULLSCREEN',
        closable: false,
        autoCloseSec: 8,
        startsAt: '2030-01-01T00:00:00.000Z',
        endsAt: '2030-02-01T00:00:00.000Z',
        everyMinutes: 30,
        maxPerDay: 5,
      }),
    );
    expect(created.status).toBe(201);
    const id = created.body.ad.id as string;
    await owner
      .post(`/control/ads/${id}/status`, { status: 'PAUSED' })
      .expect(200);
    await owner
      .put(`/control/ads/${id}`, adInput({ title: 'Yangilandi' }))
      .expect(200);
    // Deleting needs an explicit confirmation.
    expect((await owner.del(`/control/ads/${id}`, {})).status).toBe(400);
    await owner.del(`/control/ads/${id}`, { confirm: true }).expect(200);
    const actions = (
      await ctx.db.controlAuditLog.findMany({
        where: { entityId: id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);
    expect(actions).toEqual([
      'branding.ad.create',
      'branding.ad.status',
      'branding.ad.update',
      'branding.ad.delete',
    ]);
  });

  it('delivers campaigns to the right restaurants and panels only', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    const a = await restaurant();
    const b = await restaurant();
    const all = (
      await owner.post('/control/ads', adInput({ title: 'Hamma uchun' }))
    ).body.ad;
    const onlyA = (
      await owner.post(
        '/control/ads',
        adInput({
          title: 'Faqat A',
          targetMode: 'SELECTED',
          customerIds: [a.customer.id],
          panels: ['KITCHEN'],
        }),
      )
    ).body.ad;
    const draft = (
      await owner.post(
        '/control/ads',
        adInput({ title: 'Qoralama', status: 'DRAFT' }),
      )
    ).body.ad;
    const idsOf = async (staff: request.Agent, panel?: string) =>
      (
        await api(staff).get(`/branding${panel ? `?panel=${panel}` : ''}`)
      ).body.ads.map((ad: { id: string }) => ad.id) as string[];
    expect(await idsOf(a.staff)).toEqual(
      expect.arrayContaining([all.id, onlyA.id]),
    );
    expect(await idsOf(a.staff)).not.toContain(draft.id);
    // Restaurant B never sees A's campaign.
    expect(await idsOf(b.staff)).toContain(all.id);
    expect(await idsOf(b.staff)).not.toContain(onlyA.id);
    // Panel targeting.
    expect(await idsOf(a.staff, 'KITCHEN')).toContain(onlyA.id);
    expect(await idsOf(a.staff, 'CASHIER')).not.toContain(onlyA.id);
    // Pausing or disabling advertising for one restaurant removes it at once.
    await owner
      .post(`/control/ads/${all.id}/status`, { status: 'PAUSED' })
      .expect(200);
    clearBundleCache();
    expect(await idsOf(b.staff)).not.toContain(all.id);
    await owner
      .post(`/control/ads/${all.id}/status`, { status: 'ACTIVE' })
      .expect(200);
    await ctx.db.controlPolicy.update({
      where: { customerId: b.customer.id },
      data: { features: { 'ads.display': { mode: 'OFF' } } },
    });
    clearBundleCache();
    expect(await idsOf(b.staff)).toEqual([]);
    expect(await idsOf(a.staff)).toContain(all.id);
  });

  it('counts displays per restaurant, ignores foreign campaigns and reports delivery', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    const a = await restaurant();
    const b = await restaurant();
    const ad = (
      await owner.post(
        '/control/ads',
        adInput({ targetMode: 'SELECTED', customerIds: [a.customer.id] }),
      )
    ).body.ad;
    for (let index = 0; index < 3; index += 1)
      await api(a.staff)
        .post(`/branding/ads/${ad.id}/event`, {
          event: 'shown',
          panel: 'CASHIER',
        })
        .expect(204);
    await api(a.staff)
      .post(`/branding/ads/${ad.id}/event`, {
        event: 'closed',
        panel: 'CASHIER',
      })
      .expect(204);
    // B was not targeted: the event is accepted but nothing is recorded.
    await api(b.staff)
      .post(`/branding/ads/${ad.id}/event`, {
        event: 'shown',
        panel: 'CASHIER',
      })
      .expect(204);
    const stats = (await owner.get(`/control/ads/${ad.id}/stats`)).body
      .customers as { customerId: string; shown: number; closed: number }[];
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      customerId: a.customer.id,
      shown: 3,
      closed: 1,
    });
    const list = (await owner.get('/control/ads')).body.ads.find(
      (row: { id: string }) => row.id === ad.id,
    );
    expect(list.stats).toMatchObject({ shown: 3, closed: 1 });
  });
});

describe('remote design', () => {
  it('layers global and per-restaurant design, restores defaults and isolates tenants', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    const a = await restaurant();
    const b = await restaurant();
    // A clean start: other runs of this suite share the test database.
    await ctx.db.brandingDesign.deleteMany({});
    clearBundleCache();
    const logo = (await owner.upload('/control/media?name=logo.png', png()))
      .body.media;
    // No design yet: the classic look.
    const first = await request(ctx.app).get(
      `/api/branding/login?tenant=${a.tenant.slug}`,
    );
    expect(first.body.login.skin).toBe('classic');
    // Unknown media and unknown skins are refused.
    expect(
      (
        await owner.put('/control/design/global', {
          login: { logo: randomUUID() },
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner.put('/control/design/global', { login: { skin: 'neon' } }))
        .status,
    ).toBe(400);
    await owner
      .put('/control/design/global', {
        login: { skin: 'premium', welcome: 'Xush kelibsiz!', logo: logo.id },
        panels: { cashier: { skin: 'blue' } },
      })
      .expect(200);
    clearBundleCache();
    const globalLogin = await request(ctx.app).get(
      `/api/branding/login?tenant=${b.tenant.slug}`,
    );
    expect(globalLogin.body.login).toMatchObject({
      skin: 'premium',
      welcome: 'Xush kelibsiz!',
      logo: logo.id,
    });
    expect(globalLogin.body.panels.cashier.skin).toBe('blue');
    // Restaurant A overrides only what it sets.
    await owner
      .put(`/control/customers/${a.customer.id}/design`, {
        login: { skin: 'luxury' },
        panels: { waiter: { skin: 'emerald' } },
      })
      .expect(200);
    clearBundleCache();
    const aLogin = (
      await request(ctx.app).get(`/api/branding/login?tenant=${a.tenant.slug}`)
    ).body;
    expect(aLogin.login).toMatchObject({
      skin: 'luxury',
      welcome: 'Xush kelibsiz!',
    });
    expect(aLogin.panels.waiter.skin).toBe('emerald');
    const bLogin = (
      await request(ctx.app).get(`/api/branding/login?tenant=${b.tenant.slug}`)
    ).body;
    expect(bLogin.login.skin).toBe('premium');
    expect(bLogin.panels.waiter.skin).toBe('classic');
    // Signed-in staff get the same resolved design.
    expect((await api(a.staff).get('/branding')).body.design.login.skin).toBe(
      'luxury',
    );
    // An unknown business code reveals nothing: it gets the global design.
    const unknown = await request(ctx.app).get(
      '/api/branding/login?tenant=bunday-restoran-yoq',
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.login.skin).toBe('premium');
    // Restore: removing A's layer returns to the global design; removing that, to classic.
    expect(
      (await owner.del(`/control/customers/${a.customer.id}/design`, {}))
        .status,
    ).toBe(400);
    await owner
      .del(`/control/customers/${a.customer.id}/design`, { confirm: true })
      .expect(200);
    clearBundleCache();
    expect(
      (
        await request(ctx.app).get(
          `/api/branding/login?tenant=${a.tenant.slug}`,
        )
      ).body.login.skin,
    ).toBe('premium');
    await owner.del('/control/design/global', { confirm: true }).expect(200);
    clearBundleCache();
    expect(
      (
        await request(ctx.app).get(
          `/api/branding/login?tenant=${a.tenant.slug}`,
        )
      ).body.login.skin,
    ).toBe('classic');
    // Every change is audited with the old and new values.
    const changes = await ctx.db.controlAuditLog.findMany({
      where: { action: { startsWith: 'branding.design' } },
    });
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(
      changes.some((row) => JSON.stringify(row.data ?? {}).includes('luxury')),
    ).toBe(true);
  });

  it('lets a restaurant Admin design only while the Owner delegated it', async () => {
    const { agent } = await ownerSession();
    const owner = api(agent);
    const r = await restaurant();
    const admin = api(r.staff);
    // Not delegated: closed.
    expect(
      (await admin.put('/branding/admin', { login: { skin: 'blue' } })).status,
    ).toBe(403);
    expect((await admin.get('/branding/admin')).body.delegated).toBe(false);
    expect((await admin.upload('/branding/admin/media', png())).status).toBe(
      403,
    );
    // The Owner switches design.admin on for this restaurant.
    await ctx.db.controlPolicy.update({
      where: { customerId: r.customer.id },
      data: { features: { 'design.admin': { mode: 'ON' } } },
    });
    clearPolicyCache();
    clearAdminSettingsCache();
    clearBundleCache();
    expect((await admin.get('/branding/admin')).body.delegated).toBe(true);
    // Only the delegated fields are accepted (no splash, no foreign keys).
    expect(
      (await admin.put('/branding/admin', { splash: { title: 'X' } })).status,
    ).toBe(400);
    expect(
      (
        await admin.put('/branding/admin', {
          login: { background: randomUUID() },
        })
      ).status,
    ).toBe(400);
    const logo = (await admin.upload('/branding/admin/media', png())).body
      .media;
    await admin
      .put('/branding/admin', {
        login: { skin: 'emerald', welcome: 'Salom, mehmon', logo: logo.id },
        panels: { kitchen: { skin: 'minimal' } },
      })
      .expect(200);
    const seen = (await admin.get('/branding')).body.design;
    expect(seen.login).toMatchObject({
      skin: 'emerald',
      welcome: 'Salom, mehmon',
    });
    expect(seen.panels.kitchen.skin).toBe('minimal');
    // The Owner's design for this restaurant stays underneath and wins when delegation ends.
    await owner
      .put(`/control/customers/${r.customer.id}/design`, {
        login: { skin: 'luxury' },
      })
      .expect(200);
    await ctx.db.controlPolicy.update({
      where: { customerId: r.customer.id },
      data: { features: { 'design.admin': { mode: 'OFF' } } },
    });
    clearPolicyCache();
    clearAdminSettingsCache();
    clearBundleCache();
    expect((await admin.get('/branding')).body.design.login.skin).toBe(
      'luxury',
    );
    // Another restaurant's Admin can not touch this layer.
    const other = await restaurant({
      features: { 'design.admin': { mode: 'ON' } },
    });
    await api(other.staff)
      .put('/branding/admin', { login: { skin: 'blue' } })
      .expect(200);
    expect((await api(r.staff).get('/branding')).body.design.login.skin).toBe(
      'luxury',
    );
    // The change is audited in the restaurant's own log with old and new values.
    const entries = await ctx.db.auditLog.findMany({
      where: { tenantId: r.tenant.tenant.id, action: 'branding.design.admin' },
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.data)).toContain('emerald');
  });

  it('tells open screens to reload when the Owner changes the design', async () => {
    const { agent } = await ownerSession();
    const r = await restaurant();
    const seen: string[] = [];
    const stop = bus.subscribe((event) => {
      if (event.type === 'branding.changed') seen.push(event.tenantId);
    });
    await api(agent)
      .put(`/control/customers/${r.customer.id}/design`, {
        login: { skin: 'blue' },
      })
      .expect(200);
    stop();
    expect(seen).toContain(r.tenant.tenant.id);
  });
});
