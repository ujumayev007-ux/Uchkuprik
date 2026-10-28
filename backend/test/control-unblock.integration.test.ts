import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateIdentity,
  generateLicenseKey,
} from '../src/modules/control/keys.js';
import { createControlRuntime } from '../src/modules/control/runtime.js';
import {
  clearAdminSettingsCache,
  clearPolicyCache,
} from '../src/modules/control/view.js';
import { clearLicenseCache } from '../src/modules/license/license.js';
import { createEventBus } from '../src/realtime/bus.js';
import {
  createTenant,
  createTestContext,
  login,
  unique,
} from './helpers.js';

// Owner → Mijozlar: a blocked customer (or a blocked computer) is unblocked and the
// restaurant works again after its next check-in; the licence end date is unchanged.

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
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
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
install.services.installId = 'FF-TEST-UNBLOCK-01';
install.services.appVersion = '1.15.8';
// Screens of the restaurant listen here (Socket.io relays these events).
install.services.events = createEventBus();
const announced: string[] = [];
install.services.events.subscribe((event) => announced.push(event.type));
const configChanges = () => announced.filter((type) => type === 'config.changed').length;

afterAll(async () => {
  await install.close();
  await central.close();
});

const fresh = () => {
  runtime.invalidate();
  clearLicenseCache();
  clearPolicyCache();
  clearAdminSettingsCache();
};

async function linkedRestaurant() {
  await install.db.controlLink.deleteMany({});
  runtime._resetClock();
  fresh();
  const key = generateLicenseKey();
  const customer = await central.db.controlCustomer.create({
    data: { name: unique('Mijoz') },
  });
  const license = await central.db.controlLicense.create({
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
    data: { customerId: customer.id, offlineEnabled: true, maxOfflineMinutes: 120 },
  });
  const result = await runtime.activate({
    licenseKey: key,
    deviceName: 'Kassa',
    serverUrl: 'https://central.test',
  });
  expect(result.ok).toBe(true);
  fresh();
  const tenant = await createTenant(install);
  return { customerId: customer.id, licenseId: license.id, tenant };
}

const beatAndMode = async () => {
  expect(await runtime.beat()).toBe('ok');
  fresh();
  return (await runtime.status()).mode;
};

describe('unblocking a customer', () => {
  it('a blocked customer works again after unblocking; the licence end is unchanged', async () => {
    const { customerId, licenseId, tenant } = await linkedRestaurant();
    expect(await beatAndMode()).toBe('ONLINE');
    const ends = (await central.db.controlLicense.findUniqueOrThrow({ where: { id: licenseId } })).expiresAt;

    await central.db.controlCustomer.update({ where: { id: customerId }, data: { status: 'SUSPENDED' } });
    const beforeBlock = configChanges();
    expect(await beatAndMode()).toBe('BLOCKED');
    // Open screens are told at once (they show the notice without a reload).
    expect(configChanges()).toBe(beforeBlock + 1);
    // Signing in stays possible; the restaurant's work is refused while blocked.
    const staff = install.agent();
    await login(staff, tenant.slug, 'owner').expect(200);
    const refused = await staff.get('/api/menu').expect(403);
    expect(refused.body.code).toBe('DEVICE_BLOCKED');

    await central.db.controlCustomer.update({ where: { id: customerId }, data: { status: 'ACTIVE' } });
    const beforeUnblock = configChanges();
    expect(await beatAndMode()).toBe('ONLINE');
    expect(configChanges()).toBe(beforeUnblock + 1);
    // A check-in without a change announces nothing.
    await beatAndMode();
    expect(configChanges()).toBe(beforeUnblock + 1);
    // The same session works again: nothing was reset on the restaurant side.
    await staff.get('/api/menu').expect(200);
    expect(
      (await central.db.controlLicense.findUniqueOrThrow({ where: { id: licenseId } })).expiresAt,
    ).toEqual(ends);
  });

  it('a blocked computer works again after unblocking', async () => {
    const { customerId, tenant } = await linkedRestaurant();
    expect(await beatAndMode()).toBe('ONLINE');
    const activation = await central.db.controlActivation.findFirstOrThrow({ where: { customerId } });
    await central.db.controlActivation.update({ where: { id: activation.id }, data: { status: 'BLOCKED' } });
    expect(await beatAndMode()).toBe('BLOCKED');
    await central.db.controlActivation.update({ where: { id: activation.id }, data: { status: 'ACTIVE' } });
    expect(await beatAndMode()).toBe('ONLINE');
    const staff = install.agent();
    await login(staff, tenant.slug, 'owner').expect(200);
    await staff.get('/api/menu').expect(200);
  });
});
