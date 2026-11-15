// Staging check of two-way replication with REAL server processes (no mocks):
//   centre ("hub")  : node backend/dist/server.js, CONTROL_PLANE=true, database ff_hub
//   Kassa ("spoke") : node backend/dist/server.js, SELF_HOSTED=true,  database ff_spoke
// Each has its own APP_SECRET_KEY. The Kassa reports to the centre over HTTP with its
// signed device channel. Scenarios: first copy, Admin on the centre with the Kassa
// process stopped, both running, the centre unreachable (internet down) and reconnection.
// Usage (repo root): node scripts/verify/replication-staging.mjs <hubDbUrl> <spokeDbUrl>
// Both databases must be empty and migrated.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const backend = path.join(root, 'backend');
const dist = (p) => pathToFileURL(path.join(backend, 'dist', p)).href;
const [hubDb, spokeDb] = process.argv.slice(2);
if (!hubDb || !spokeDb) throw new Error('usage: <hubDbUrl> <spokeDbUrl>');

const { generateIdentity, generateLicenseKey } = await import(
  dist('modules/control/keys.js')
);
const { createSecretBox } = await import(dist('lib/crypto.js'));
const { createPrisma } = await import(dist('db.js'));
const { createBusinessTenant } = await import(
  dist('modules/tenants/provisioning.js')
);
const { planFeatures } = await import(dist('modules/billing/entitlements.js'));
void createRequire;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

const HUB_PORT = 8899;
const SPOKE_PORT = 8898;
const hubKey = randomBytes(32).toString('base64');
const spokeKey = randomBytes(32).toString('base64');
const signing = generateIdentity();
const device = generateIdentity();
const PASSWORD = 'Staging-parol-2026';

function startServer(name, port, env) {
  const child = spawn(
    process.execPath,
    [path.join(backend, 'dist', 'server.js')],
    {
      cwd: backend,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        LOG_LEVEL: 'warn',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', () => {});
  child.stderr.on(
    'data',
    (d) => process.env.STAGING_DEBUG && process.stderr.write(`[${name}] ${d}`),
  );
  return child;
}
const hubEnv = {
  DATABASE_URL: hubDb,
  APP_SECRET_KEY: hubKey,
  CONTROL_PLANE: 'true',
  CONTROL_SIGNING_KEY: Buffer.from(signing.privateKeyPem).toString('base64'),
};
const spokeEnv = {
  DATABASE_URL: spokeDb,
  APP_SECRET_KEY: spokeKey,
  SELF_HOSTED: 'true',
  CONTROL_URL: `http://127.0.0.1:${HUB_PORT}`,
  CONTROL_PUBLIC_KEY: signing.publicKey,
  CONTROL_DEVICE_KEY: Buffer.from(device.privateKeyPem).toString('base64'),
  INSTALL_ID: 'FF-STAGE-0001-0001',
};
async function waitReady(port, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });

/** Minimal browser: cookies and the Origin header of its server. */
function client(port) {
  const jar = new Map();
  return async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const line of r.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data };
  };
}
const until = async (what, fn, seconds = 60) => {
  for (let i = 0; i < seconds; i++) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`   (timed out waiting for: ${what})`);
  return false;
};

// ---- setup: licence on the centre, restaurant on the Kassa
const hubDbClient = createPrisma(hubDb);
const spokeDbClient = createPrisma(spokeDb);
const hubSecrets = createSecretBox(hubKey);
const licenseKey = generateLicenseKey();
const customer = await hubDbClient.controlCustomer.create({
  data: { name: 'Staging restoran' },
});
await hubDbClient.controlLicense.create({
  data: {
    customerId: customer.id,
    keyHash: hubSecrets.keyedHash('license-key', licenseKey),
    keyHint: licenseKey.slice(-5),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    maxInstalls: 3,
    // As the Owner issues it by default: every module.
    features: [...planFeatures],
  },
});
await hubDbClient.controlPolicy.create({
  data: {
    customerId: customer.id,
    offlineEnabled: true,
    maxOfflineMinutes: 600,
  },
});
const slug = `stg${randomBytes(3).toString('hex')}`;
const { scryptSync } = await import('node:crypto');
void scryptSync;
const created = await spokeDbClient.$transaction((tx) =>
  createBusinessTenant(tx, {
    slug,
    name: 'Staging Fast Food',
    branchName: 'Markaziy filial',
    owner: { username: 'owner', displayName: 'Egasi', password: PASSWORD },
  }),
);
const tenantId = created.tenant.id;
await spokeDbClient.user.update({
  where: { id: created.owner.id },
  data: { mustChangePassword: false },
});

let hub = startServer('hub', HUB_PORT, hubEnv);
let spoke = startServer('kassa', SPOKE_PORT, spokeEnv);
check('markaz (hub) ishga tushdi', await waitReady(HUB_PORT));
check('Kassa serveri ishga tushdi', await waitReady(SPOKE_PORT));

const kassa = client(SPOKE_PORT);
const login = (c) =>
  c('POST', '/auth/login', {
    tenant: slug,
    username: 'owner',
    password: PASSWORD,
  });
check('Kassa: Admin kirdi', (await login(kassa)).status === 200);
const act = await kassa('POST', '/control/link/activate', {
  licenseKey,
  deviceName: 'Kassa',
});
check(
  'Kassa litsenziya bilan markazga bog‘landi',
  act.status === 200 || act.status === 201,
  String(act.status),
);

// Real Kassa data: a stock item and a Bozorlik purchase.
const item = await kassa('POST', '/inventory/items', {
  name: 'Go‘sht',
  baseUnit: 'G',
  minStock: 0,
});
const stockItemId = item.data?.id;
await kassa('POST', '/purchases/market', {
  supplierName: 'Chorsu',
  paid: true,
  paymentMethod: 'CARD',
  lines: [{ stockItemId, quantity: '10', unitName: 'kg', lineTotal: 900000 }],
});
const attach = await kassa('POST', '/replication/attach', {});
check(
  'Sinxronlash yoqildi',
  attach.status === 201,
  `navbatga: ${attach.data?.queued}`,
);

const balance = async (db) =>
  String(
    (await db.stockBalance.findFirst({ where: { tenantId, stockItemId } }))
      ?.quantity ?? '',
  );
check(
  'Birinchi nusxa markazga yetdi (o‘z-o‘zidan, 5 s sikl)',
  await until('hub copy', async () => (await balance(hubDbClient)) === '10000'),
);

// ---- 1. Kassa completely stopped: the Admin works through the centre
await stop(spoke);
check(
  'Kassa jarayoni TO‘XTATILDI',
  spoke.exitCode !== null || spoke.signalCode !== null,
);
const centre = client(HUB_PORT);
check(
  'Markaz: Admin kirdi (Kassa o‘chiq)',
  (await login(centre)).status === 200,
);
const items = await centre('GET', '/inventory/items');
const meat = items.data?.items?.find((i) => i.id === stockItemId);
check(
  'Markaz: ombor qoldig‘i ko‘rinadi',
  meat?.quantity === '10000',
  meat?.quantity,
);
const buy = await centre('POST', '/purchases/market', {
  supplierName: 'Ulgurji',
  paid: true,
  paymentMethod: 'CARD',
  lines: [
    { stockItemId, quantity: '2', unitName: 'kg', lineTotal: 180000 },
    {
      newItem: { name: 'Piyoz', baseUnit: 'G' },
      quantity: '5',
      unitName: 'kg',
      lineTotal: 40000,
    },
  ],
});
check(
  'Markaz: Bozorlik saqlandi (Kassa o‘chiq)',
  buy.status === 201,
  String(buy.status),
);
const hire = await centre('POST', '/users', {
  username: 'ofitsiant2',
  displayName: 'Yangi ofitsiant',
  password: 'Ofitsiant-parol-2026',
  roleIds: [
    (
      await hubDbClient.role.findFirst({
        where: { tenantId, systemKey: 'waiter' },
      })
    )?.id,
  ].filter(Boolean),
  allBranches: true,
  branchIds: [],
});
check(
  'Markaz: yangi xodim qo‘shildi',
  hire.status === 201,
  String(hire.status),
);

// ---- 2. Kassa back on: it receives everything
spoke = startServer('kassa', SPOKE_PORT, spokeEnv);
check('Kassa qayta yoqildi', await waitReady(SPOKE_PORT));
check(
  'Kassa markazdagi Bozorlikni oldi (12 kg)',
  await until(
    'spoke pull',
    async () => (await balance(spokeDbClient)) === '12000',
  ),
);
check(
  'Kassa markazda qo‘shilgan xodimni oldi',
  (await spokeDbClient.user.count({
    where: { tenantId, username: 'ofitsiant2' },
  })) === 1,
);

// ---- 3. Internet down (centre unreachable): the Kassa keeps selling
await stop(hub);
check(
  'Markaz TO‘XTATILDI (internet yo‘q)',
  hub.exitCode !== null || hub.signalCode !== null,
);
await login(kassa);
const category = await spokeDbClient.menuCategory.create({
  data: { tenantId, name: 'Taomlar' },
});
const product = await spokeDbClient.product.create({
  data: { tenantId, categoryId: category.id, name: 'Lavash' },
});
const variant = await spokeDbClient.productVariant.create({
  data: {
    tenantId,
    productId: product.id,
    name: 'Oddiy',
    price: 30000,
    cost: 12000,
  },
});
await kassa('POST', '/shifts/open', { openingCash: 50000 });
const order = await kassa('POST', '/orders', {
  idempotencyKey: randomUUID(),
  type: 'TAKEAWAY',
  items: [{ variantId: variant.id, quantity: 2 }],
});
const paid = await kassa('POST', `/orders/${order.data?.id}/payments`, {
  idempotencyKey: randomUUID(),
  method: 'CASH',
  amount: 60000,
  tendered: 60000,
});
check(
  'Kassa internetsiz sotdi',
  order.status === 201 && paid.status === 201,
  `${order.status}/${paid.status}`,
);
const stocktake = await kassa('POST', '/inventory/stocktakes', {
  counts: [{ stockItemId, counted: '11000' }],
  reason: 'Buzilgan',
});
check(
  'Kassa internetsiz ombor sanog‘i (-1 kg)',
  stocktake.status === 201,
  `${stocktake.status} ${JSON.stringify(stocktake.data).slice(0, 200)}`,
);
const status = await kassa('GET', '/replication/status');
check(
  'Navbatda o‘zgarishlar turibdi',
  (status.data?.pending ?? 0) > 0,
  `${status.data?.pending} ta`,
);

// ---- 4. Internet back: the queue goes out, no duplicates
hub = startServer('hub', HUB_PORT, hubEnv);
check('Markaz qayta yoqildi', await waitReady(HUB_PORT));
check(
  'Internetsiz buyurtma markazga yetdi',
  // backoff after the outage can reach 60 s
  await until(
    'order on hub',
    async () =>
      !!(await hubDbClient.order.findUnique({ where: { id: order.data.id } })),
    90,
  ),
);
check(
  'Ikkala tomonda qoldiq bir xil: 10 + 2 − 1 = 11 kg',
  await until(
    'converge',
    async () =>
      (await balance(hubDbClient)) === '11000' &&
      (await balance(spokeDbClient)) === '11000',
  ),
  `markaz ${await balance(hubDbClient)}, Kassa ${await balance(spokeDbClient)}`,
);
const [hm, sm] = await Promise.all([
  hubDbClient.stockMovement.count({ where: { tenantId } }),
  spokeDbClient.stockMovement.count({ where: { tenantId } }),
]);
check('Ombor harakatlari takrorlanmadi', hm === sm, `${hm} = ${sm}`);
const [he, se] = await Promise.all([
  hubDbClient.expense.count({ where: { tenantId, category: 'Bozorlik' } }),
  spokeDbClient.expense.count({ where: { tenantId, category: 'Bozorlik' } }),
]);
check(
  'Bozorlik xarajatlari bir xil (takrorsiz)',
  he === 2 && se === 2,
  `${he}/${se}`,
);
const hubPay = await hubDbClient.payment.findMany({
  where: { orderId: order.data.id },
});
check(
  'To‘lov markazda bir marta',
  hubPay.length === 1 && hubPay[0].amount === 60000,
);

// ---- 5. Both running: the Admin sees the Kassa sale in the centre's order list
await login(centre);
const list = await centre('GET', '/orders?limit=50');
check(
  'Markaz: Admin buyurtmani ro‘yxatda ko‘radi',
  JSON.stringify(list.data).includes(order.data.id),
);
const conflicts = await hubDbClient.replicationConflict.count({
  where: { tenantId },
});
const parked = await hubDbClient.replicationParked.count({
  where: { tenantId },
});
check(
  'Markazda qo‘llanmagan o‘zgarish yo‘q',
  conflicts === 0 && parked === 0,
  `${conflicts}/${parked}`,
);

await stop(spoke);
await stop(hub);
await hubDbClient.$disconnect();
await spokeDbClient.$disconnect();
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} TA XATO` : `HAMMASI O‘TDI (${results.length})`);
process.exit(failed ? 1 : 0);
