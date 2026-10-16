import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearBundleCache } from '../src/modules/branding/bundle.js';
import { scheduleAdStats } from '../src/modules/control/outbox.js';
import {
  generateIdentity,
  generateLicenseKey,
  signValue,
} from '../src/modules/control/keys.js';
import { createControlRuntime } from '../src/modules/control/runtime.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
} from '../src/modules/control/view.js';
import { clearLicenseCache } from '../src/modules/license/license.js';
import {
  createTenant,
  createTestContext,
  login,
  ORIGIN,
  unique,
} from './helpers.js';

// Installed restaurants receive the Owner's design and advertisements through the
// signed heartbeat, keep them for offline use and report display counters back.

const server = generateIdentity();
const central = createTestContext({
  control: {
    plane: true,
    signingKeyPem: server.privateKeyPem,
    trustedKeys: [server.publicKey],
  },
});
const install = createTestContext({
  selfHosted: true,
  control: {
    plane: false,
    trustedKeys: [server.publicKey],
    url: 'https://central.test',
  },
});
const network = { down: false };
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
  if (network.down) throw new TypeError('network down');
  const path = new URL(String(url)).pathname;
  const response = await request(central.app)
    .post(path)
    .send(JSON.parse(String(init?.body ?? '{}')));
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
const runtime = createControlRuntime(install.services, { transport });
install.services.controlRuntime = runtime;
install.services.controlView = runtime.view;
install.services.installId = 'FF-TEST-0002-0001';
install.services.appVersion = '1.12.0';

afterAll(async () => {
  await install.close();
  await central.close();
});

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 9),
  ]);

async function setup() {
  install.clock.offsetMs = central.clock.offsetMs;
  await install.db.controlLink.deleteMany({});
  await install.db.syncOperation.deleteMany({});
  await install.db.brandingCache.deleteMany({});
  await install.db.adStat.deleteMany({});
  await install.db.adCampaign.deleteMany({});
  await install.db.brandingDesign.deleteMany({});
  runtime.invalidate();
  runtime._resetClock();
  clearLicenseCache();
  clearPolicyCache();
  clearAdminSettingsCache();
  clearBundleCache();
  const key = generateLicenseKey();
  const customer = await central.db.controlCustomer.create({
    data: { name: unique('Mijoz') },
  });
  await central.db.controlLicense.create({
    data: {
      customerId: customer.id,
      keyHash: central.services.secrets.keyedHash('license-key', key),
      keyHint: key.slice(-5),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      maxInstalls: 5,
      features: [],
    },
  });
  await central.db.controlPolicy.create({
    data: {
      customerId: customer.id,
      offlineEnabled: true,
      maxOfflineMinutes: 120,
    },
  });
  const result = await runtime.activate({
    licenseKey: key,
    deviceName: 'Test kassa',
    serverUrl: 'https://central.test',
  });
  expect(result.ok).toBe(true);
  runtime.invalidate();
  return { customerId: customer.id };
}

const campaign = (overrides: Record<string, unknown> = {}) =>
  central.db.adCampaign.create({
    data: {
      title: 'Bahor aksiyasi',
      kind: 'TEXT',
      format: 'POPUP',
      text: 'Bahor menyusi keldi!',
      panels: ['CASHIER', 'WAITER'],
      targetMode: 'ALL',
      status: 'ACTIVE',
      ...overrides,
    },
  });

describe('branding on an installed restaurant', () => {
  let customerId = '';
  beforeAll(async () => {
    ({ customerId } = await setup());
  });

  it('receives design and advertising by heartbeat, serves them offline, reports counters', async () => {
    const logo = await central.db.brandingMedia.create({
      data: {
        kind: 'IMAGE',
        mime: 'image/png',
        name: 'markaziy',
        sizeBytes: png().length,
        sha256: createHash('sha256').update(png()).digest('hex'),
        data: png(),
      },
    });
    await central.db.brandingDesign.create({
      data: {
        key: 'global',
        config: {
          login: { skin: 'luxury', welcome: 'Xush kelibsiz!', logo: logo.id },
          panels: { cashier: { skin: 'premium' } },
        },
      },
    });
    const ad = await campaign({ everyMinutes: 15 });
    clearBundleCache();
    expect(await runtime.beat()).toBe('ok');
    await runtime.brandingSettled();
    const cached = await install.db.brandingCache.findUniqueOrThrow({
      where: { id: 1 },
    });
    const bundle = cached.bundle as {
      v: string;
      design: { login: { skin: string } };
      ads: { id: string; everyMinutes: number }[];
      media: { id: string }[];
    };
    expect(bundle.design.login.skin).toBe('luxury');
    expect(bundle.ads.map((item) => item.id)).toEqual([ad.id]);
    expect(bundle.media.map((item) => item.id)).toEqual([logo.id]);
    // Delivery is acknowledged once the install reports the version it holds.
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearBundleCache();
    expect(await runtime.beat()).toBe('ok');
    const delivery = await central.db.adDelivery.findFirstOrThrow({
      where: { campaignId: ad.id },
    });
    expect(delivery.ackedAt).not.toBeNull();

    // The restaurant's own screens read it from the install (internet not needed).
    network.down = true;
    const tenant = await createTenant(install);
    const staff = install.agent();
    await login(staff, tenant.slug, 'owner').expect(200);
    const seen = await staff.get('/api/branding?panel=CASHIER');
    expect(seen.status).toBe(200);
    expect(seen.body.design.login.skin).toBe('luxury');
    expect(seen.body.design.panels.cashier.skin).toBe('premium');
    expect(seen.body.ads.map((item: { id: string }) => item.id)).toEqual([
      ad.id,
    ]);
    const publicLogin = await request(install.app).get('/api/branding/login');
    expect(publicLogin.body.login).toMatchObject({
      skin: 'luxury',
      welcome: 'Xush kelibsiz!',
      logo: logo.id,
    });
    // A panel the campaign does not target gets nothing.
    expect((await staff.get('/api/branding?panel=KITCHEN')).body.ads).toEqual(
      [],
    );

    // Counters are kept locally and synchronised as cumulative operations.
    for (let index = 0; index < 4; index += 1)
      await staff
        .post(`/api/branding/ads/${ad.id}/event`)
        .set('Origin', ORIGIN)
        .send({ event: 'shown', panel: 'CASHIER' })
        .expect(204);
    await staff
      .post(`/api/branding/ads/${ad.id}/event`)
      .set('Origin', ORIGIN)
      .send({ event: 'closed', panel: 'CASHIER' })
      .expect(204);
    network.down = false;
    await scheduleAdStats(install.services);
    expect(
      await install.db.syncOperation.count({ where: { type: 'ad_stats' } }),
    ).toBe(1);
    await runtime.sync();
    const applied = await central.db.controlSyncOp.findFirst({
      where: { customerId, type: 'ad_stats', status: 'APPLIED' },
    });
    expect(applied).not.toBeNull();
    const stat = await central.db.adStat.findFirstOrThrow({
      where: { campaignId: ad.id, customerId },
    });
    expect(stat).toMatchObject({ shown: 4, closed: 1 });
    // Reporting again without new displays creates nothing; new displays create a new report.
    await scheduleAdStats(install.services);
    expect(
      await install.db.syncOperation.count({ where: { type: 'ad_stats' } }),
    ).toBe(1);
  });

  it('follows pausing, deleting and the restaurant switch for advertising', async () => {
    const ad = await campaign({ title: 'Ikkinchi' });
    clearBundleCache();
    await runtime.beat();
    await runtime.brandingSettled();
    let cached = await install.db.brandingCache.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(
      (cached.bundle as { ads: { id: string }[] }).ads.map((a) => a.id),
    ).toContain(ad.id);
    await central.db.adCampaign.update({
      where: { id: ad.id },
      data: { status: 'PAUSED', version: { increment: 1 } },
    });
    clearBundleCache();
    await runtime.beat();
    await runtime.brandingSettled();
    cached = await install.db.brandingCache.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(
      (cached.bundle as { ads: { id: string }[] }).ads.map((a) => a.id),
    ).not.toContain(ad.id);
    // Switching advertising off for this restaurant removes every campaign.
    await central.db.controlPolicy.update({
      where: { customerId },
      data: { features: { 'ads.display': { mode: 'OFF' } } },
    });
    clearPolicyCache();
    clearBundleCache();
    await campaign({ title: 'Uchinchi' });
    clearBundleCache();
    await runtime.beat();
    await runtime.brandingSettled();
    cached = await install.db.brandingCache.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect((cached.bundle as { ads: unknown[] }).ads).toEqual([]);
  });

  it("hands out only files of the restaurant's own bundle on the signed device channel", async () => {
    const link = await install.db.controlLink.findUniqueOrThrow({
      where: { id: 1 },
    });
    const pem = install.services.secrets.decrypt(link.deviceKeyEnc!);
    const mine = await central.db.brandingMedia.findFirstOrThrow({
      where: { name: 'markaziy' },
      orderBy: { createdAt: 'desc' },
    });
    const foreign = await central.db.brandingMedia.create({
      data: {
        kind: 'IMAGE',
        mime: 'image/png',
        name: 'boshqa',
        sizeBytes: png().length,
        sha256: createHash('sha256').update(png()).digest('hex'),
        data: png(),
      },
    });
    let seq = Date.now();
    const ask = (id: string) => {
      seq += 1;
      const ts = Date.now() + central.clock.offsetMs;
      const payload = { id };
      return request(central.app)
        .post('/api/control/device/media')
        .send({
          activationId: link.activationId,
          seq,
          ts,
          payload,
          sig: signValue(pem, {
            type: 'media',
            activationId: link.activationId,
            seq,
            ts,
            payload,
          }),
        });
    };
    clearBundleCache();
    expect((await ask(foreign.id)).status).toBe(404);
    // `mine` is referenced by the design assigned earlier in this suite.
    const ok = await ask(mine.id);
    expect(ok.status).toBe(200);
    expect(
      createHash('sha256')
        .update(Buffer.from(ok.body.data, 'base64'))
        .digest('hex'),
    ).toBe(ok.body.sha256);
    // A request signed with another key is refused.
    const other = generateIdentity();
    const ts = Date.now() + central.clock.offsetMs;
    const forged = await request(central.app)
      .post('/api/control/device/media')
      .send({
        activationId: link.activationId,
        seq: seq + 10,
        ts,
        payload: { id: mine.id },
        sig: signValue(other.privateKeyPem, {
          type: 'media',
          activationId: link.activationId,
          seq: seq + 10,
          ts,
          payload: { id: mine.id },
        }),
      });
    expect(forged.status).toBe(403);
  });
});
