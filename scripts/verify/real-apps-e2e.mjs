// Real built applications together: TEST server (own database) + TEST Admin, Kassa and
// Oshxona shells that find the server by themselves; a real order goes Kassa -> Oshxona
// -> TV/Admin and every status change is checked on every panel.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = 'C:/Users/PRESTIGE/fastfood-app';
const require = createRequire(`${root}/package.json`);
const { chromium } = require('@playwright/test');
const serverExe = `${root}/desktop/release-test/win-unpacked/FastFoodTest.exe`;
const shellExe = (k, name, tag = 't4') =>
  `${root}/admin-desktop/release-${tag}-${k}/win-unpacked/${name}`;
const BASE = 'http://127.0.0.1:8788';
const ORIGIN = 'http://localhost:8788';
const ok = [];
const check = (n, v, d = '') => {
  ok.push(v);
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PS_KILL = [
  'Get-Process FastFoodTest,FastFoodAdminTest,FastFoodKassaTest,FastFoodOshxonaTest,FastFoodTVTest -ErrorAction SilentlyContinue | Stop-Process -Force',
  'Start-Sleep 2',
  "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*desktop\\release-test\\win-unpacked\\resources\\postgres*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  'exit 0',
].join('; ');
const PS_SERVER = [
  'Get-Process FastFoodTest -ErrorAction SilentlyContinue | Stop-Process -Force',
  'Start-Sleep 2',
  "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*desktop\\release-test\\win-unpacked\\resources\\postgres*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  'exit 0',
].join('; ');
const killServerOnly = () => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', PS_SERVER]);
  } catch {
    /* none */
  }
};
const killAll = () => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', PS_KILL]);
  } catch {
    /* none */
  }
};
async function waitFor(fn, ms = 60000, step = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  return null;
}
const tag = Math.random().toString(36).slice(2, 7);
const SLUG = `lan-${tag}`;
const PASS = `Lan-${tag}-Parol1`;

// ---------------------------------------------------------------- server
killAll();
const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'ff-e2e-data-'));
const env = { ...process.env, FASTFOOD_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
const server = spawn(serverExe, ['--remote-debugging-port=9500'], {
  env,
  stdio: 'ignore',
});
const ready = await waitFor(
  async () => (await fetch(`${BASE}/api/health/ready`)).ok,
  240000,
  2000,
);
check('server (TEST, yangi baza) ishga tushdi', !!ready);
if (!ready) {
  killAll();
  process.exit(1);
}

// ---------------------------------------------------------------- API helper
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.getSetCookie?.() ?? [];
    for (const c of set)
      if (c.startsWith('ff_session=')) cookie = c.split(';')[0];
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  };
  return {
    cookie: () => cookie,
    call,
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    login: (username, password = PASS) =>
      call('POST', '/auth/login', { tenant: SLUG, username, password }),
  };
}

const regBody = {
  businessName: 'LAN Sinov',
  slug: SLUG,
  branchName: 'Asosiy',
  ownerName: 'Aziz Egasi',
  username: 'owner',
  password: PASS,
  planCode: 'free',
  acceptTerms: true,
};
let reg = { status: 0 };
for (let i = 0; i < 4 && reg.status !== 201; i++) {
  reg = await client().post('/public/register', regBody);
  if (reg.status !== 201) await sleep(3000);
}
const unusedReg = {
  businessName: 'LAN Sinov',
  slug: SLUG,
  branchName: 'Asosiy',
  ownerName: 'Aziz Egasi',
  username: 'owner',
  password: PASS,
  planCode: 'free',
  acceptTerms: true,
};
if (reg.status !== 201)
  console.log('register', reg.status, JSON.stringify(reg.body).slice(0, 300));
const owner = client();
check(
  'restoran yaratildi va egasi kirdi',
  reg.status === 201 && (await owner.login('owner')).status === 200,
);
const cat = await owner.post('/menu/categories', { name: 'Taomlar' });
const prod = await owner.post('/menu/products', {
  categoryId: cat.body.id,
  name: 'Lagmon',
  prepTimeMinutes: 12,
  variants: [{ name: 'Standart', price: 35000 }],
});
check('menyu: Lagmon qo‘shildi', prod.status === 201, String(prod.status));
const roles = (await owner.get('/roles')).body;
const roleList = roles.roles ?? roles;
const roleId = (key) => roleList.find((r) => r.systemKey === key)?.id;
const mk = async (username, key) =>
  (
    await owner.post('/users', {
      username,
      password: PASS,
      displayName: username.toUpperCase(),
      roleIds: [roleId(key)],
      allBranches: true,
      branchIds: [],
    })
  ).status;
check(
  'xodimlar yaratildi (kassir, 2 oshpaz)',
  (await mk('kassir', 'cashier')) === 201 &&
    (await mk('oshpaz', 'kitchen')) === 201 &&
    (await mk('oshpaz2', 'kitchen')) === 201,
);
// New staff must choose their own password at the first sign-in (existing rule): do it here.
for (const name of ['kassir', 'oshpaz', 'oshpaz2']) {
  const person = client();
  await person.login(name);
  await person.post('/auth/password', {
    currentPassword: PASS,
    newPassword: `${PASS}x`,
  });
}
globalThis.STAFF_PASS = `${PASS}x`;

// ---------------------------------------------------------------- shells
const launch = async (exe, port, profile) => {
  fs.rmSync(join(process.env.APPDATA, profile, 'admin-settings.json'), {
    force: true,
  });
  const e = { ...process.env, ADMIN_NO_REVEAL: '1' };
  delete e.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    env: e,
    stdio: 'ignore',
  });
  let browser;
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await sleep(500);
    }
  }
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const main = async () => {
    for (const p of pages()) if (!p.url().includes('status.html')) return p;
  };
  return { child, browser, main };
};
const admin = await launch(
  shellExe('admin', 'FastFoodAdminTest.exe'),
  9511,
  'FastFood-Admin-Test',
);
const cashier = await launch(
  shellExe('cashier', 'FastFoodKassaTest.exe'),
  9512,
  'FastFood-Kassa-Test',
);
const kitchen = await launch(
  shellExe('kitchen', 'FastFoodOshxonaTest.exe'),
  9513,
  'FastFood-Oshxona-Test',
);
for (const [name, app] of [
  ['Admin', admin],
  ['Kassa', cashier],
  ['Oshxona', kitchen],
]) {
  const found = await waitFor(
    async () => /127\.0\.0\.1:8788/.test((await app.main()).url()),
    90000,
    1000,
  );
  check(
    `${name}: server o‘zi topildi (qo‘lda manzilsiz)`,
    !!found,
    found ? (await app.main()).url() : 'topilmadi',
  );
}

async function signIn(app, username, expectUrl) {
  const p = await app.main();
  await p.getByLabel('Biznes kodi').fill(SLUG);
  await p.getByLabel('Login').fill(username);
  await p
    .getByLabel('Parol')
    .fill(username === 'owner' ? PASS : globalThis.STAFF_PASS);
  await p.getByRole('button', { name: 'Kirish', exact: true }).click();
  return !!(await waitFor(
    async () => expectUrl.test((await app.main()).url()),
    40000,
    500,
  ));
}
check(
  'Oshxona ilovasi: kirgach oshxona ekrani ochildi',
  await signIn(kitchen, 'oshpaz', /\/oshxona/),
);
check(
  'Kassa ilovasi: kirgach Kassa ochildi',
  await signIn(cashier, 'kassir', /\/kassa/),
);
check(
  'Admin ilovasi: boshqaruv paneli ochildi',
  await signIn(admin, 'owner', /127\.0\.0\.1:8788\/?(\?.*)?$/),
);

// count the kitchen chimes
const kp = await kitchen.main();
await kp.evaluate(() => {
  window.__chimes = 0;
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...a) {
      super(...a);
      window.__chimes++;
    }
  };
});
await kp.getByRole('heading', { name: 'Oshxona ekrani' }).waitFor();

// Admin: orders list
const ap = await admin.main();
await ap.goto(`${BASE}/buyurtmalar`);

// Customer TV (browser session of the owner)
const tvBrowser = await chromium
  .launch({ channel: 'msedge' })
  .catch(() => chromium.launch());
const tvCtx = await tvBrowser.newContext();
const tv = await tvCtx.newPage();
await tv.goto(`${BASE}/kirish`);
await tv.getByLabel('Biznes kodi').fill(SLUG);
await tv.getByLabel('Login').fill('owner');
await tv.getByLabel('Parol').fill(PASS);
await tv.getByRole('button', { name: 'Kirish', exact: true }).click();
await tv.waitForURL((u) => !u.pathname.includes('kirish'));
await tv.goto(`${BASE}/navbat`);
await tv.locator('.queue-columns').waitFor({ timeout: 20000 });

// ---------------------------------------------------------------- real order from the Kassa
const cp = await cashier.main();
await cp.getByRole('heading', { name: 'Savat' }).waitFor({ timeout: 30000 });
await cp.waitForLoadState('networkidle');
const openShift = cp.getByRole('button', { name: 'Smenani ochish' });
if (await openShift.isVisible()) {
  await cp.getByLabel('Boshlang‘ich naqd pul (so‘m)').fill('0');
  await openShift.click();
  await openShift.waitFor({ state: 'detached' }).catch(() => {});
}
await cp
  .getByRole('button', { name: /Lagmon/ })
  .first()
  .click();
await cp
  .getByRole('complementary', { name: 'Savat' })
  .getByRole('button', { name: 'To‘lov qilish' })
  .click();
const dialog = cp.getByRole('dialog');
await dialog.getByLabel('Qabul qilindi (so‘m)').fill('40000');
await dialog.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
const done = cp.getByRole('dialog', { name: 'To‘lov qabul qilindi' });
const number = (await done.locator('.order-number').textContent()).replace(
  /\D/g,
  '',
);
check('Kassadan haqiqiy buyurtma berildi', !!number, `№${number}`);
await done.getByRole('button', { name: 'Yangi buyurtma' }).click();

// Oshxona gets it live, in "Yangi", with a sound
const ticket = kp.getByRole('article', { name: `№${number}` });
check(
  'Oshxonada buyurtma o‘zi paydo bo‘ldi (qayta yuklamasdan)',
  await waitFor(() => ticket.isVisible(), 15000, 300),
);
const text = await ticket.innerText();
check(
  'chiptada raqam, taom, miqdor va vaqt bor',
  text.includes(`№${number}`) &&
    /Lagmon/.test(text) &&
    /1×/.test(text) &&
    /Buyurtma vaqti: \d\d:\d\d/.test(text),
  text.replace(/\s+/g, ' ').slice(0, 120),
);
check(
  'yangi buyurtmada ovoz chalindi',
  (await kp.evaluate(() => window.__chimes)) >= 1,
  String(await kp.evaluate(() => window.__chimes)),
);
check(
  '«Yangi» bo‘limida va 4 ta tugma bor',
  /Yangi/.test(text) &&
    (await ticket.getByRole('button', { name: 'Qabul qilish' }).count()) ===
      1 &&
    (await ticket
      .getByRole('button', { name: 'Tayyorlanmoqda', exact: true })
      .count()) === 1 &&
    (await ticket
      .getByRole('button', { name: 'Tayyor', exact: true })
      .count()) === 1 &&
    (await ticket.getByRole('button', { name: 'Rad etish' }).count()) === 1,
);
check(
  'qabul qilmaguncha «Tayyorlanmoqda» va «Tayyor» bosilmaydi',
  (await ticket
    .getByRole('button', { name: 'Tayyorlanmoqda', exact: true })
    .isDisabled()) &&
    (await ticket
      .getByRole('button', { name: 'Tayyor', exact: true })
      .isDisabled()),
);
const tvText = async () =>
  (await tv.locator('.queue-columns').innerText()).replace(/\s+/g, ' ');
check(
  'TV da buyurtma «Tayyorlanmoqda» da ko‘rinadi',
  !!(await waitFor(async () => (await tvText()).includes(number), 15000, 500)),
  await tvText(),
);

// duplicate confirmation: the second cook presses at the same moment
const orderId = (await owner.get('/orders?limit=5')).body.orders?.find?.(
  (o) => String(o.number) === number,
)?.id;
const cook2 = client();
await cook2.login('oshpaz2', globalThis.STAFF_PASS);
const [r1] = await Promise.all([
  ticket
    .getByRole('button', { name: 'Qabul qilish' })
    .click({ timeout: 4000 })
    .then(() => 'ui')
    .catch(() => 'ui-late'),
  cook2.post(`/kitchen/orders/${orderId}/accept`),
]);
await sleep(1500);
const view = (await owner.get(`/orders/${orderId}`)).body;
check(
  'qabul qilish 2 kishi bir vaqtda bosganda ham bir marta yozildi',
  !!view.kitchen?.acceptedAt,
);
const events = (await owner.get(`/orders/${orderId}/events`)).body.events ?? [];
check(
  'qabul hodisasi bitta',
  events.filter((e) => e.type === 'kitchen_accept').length === 1,
  JSON.stringify(
    events.filter((e) => /kitchen/.test(e.type)).map((e) => e.type),
  ),
);
const t2 = kp.getByRole('article', { name: `№${number}` });
check(
  'qabul qilingach chipta «Qabul qilingan» bo‘limiga o‘tdi',
  !!(await waitFor(
    async () => /Qabul qilingan/.test(await t2.innerText()),
    10000,
    300,
  )),
);
check(
  'Qabul tugmasi o‘chdi, «Tayyorlanmoqda» yoqildi',
  (await t2.getByRole('button', { name: 'Qabul qilish' }).isDisabled()) &&
    !(await t2
      .getByRole('button', { name: 'Tayyorlanmoqda', exact: true })
      .isDisabled()),
);

await t2.getByRole('button', { name: 'Tayyorlanmoqda', exact: true }).click();
check(
  'Oshxona: «Tayyorlanmoqda» bo‘limi',
  !!(await waitFor(
    async () =>
      (await kp.getByRole('heading', { name: /^Tayyorlanmoqda \(/ }).count()) >
      0,
    10000,
    300,
  )),
);
const apRow = ap.locator('tr, li, article', { hasText: `${number}` }).first();
check(
  'Admin ilovasida holat o‘zi yangilandi (Tayyorlanmoqda)',
  !!(await waitFor(
    async () => /Tayyorlanmoqda/.test(await ap.locator('body').innerText()),
    15000,
    500,
  )),
);
await t2.getByRole('button', { name: 'Tayyor', exact: true }).click();
check(
  'TV da buyurtma «Tayyor» ga o‘tdi',
  !!(await waitFor(
    async () => {
      const r = tv.locator('.queue-columns .ready');
      return (await r.count()) && (await r.innerText()).includes(number);
    },
    15000,
    500,
  )),
);
check(
  'Admin ilovasida «Tayyor»',
  !!(await waitFor(
    async () => /Tayyor/.test(await ap.locator('body').innerText()),
    15000,
    500,
  )),
);
const final = (await owner.get(`/orders/${orderId}`)).body;
check(
  'server holati: READY, qabul qilgan oshpaz yozilgan',
  final.status === 'READY' && !!final.kitchen.acceptedAt,
);

// ---- second order: refused by the kitchen
const o2 = await owner.post('/orders', {
  idempotencyKey: crypto.randomUUID(),
  type: 'TAKEAWAY',
  place: true,
  items: [
    {
      variantId: new RegExp('"variants":\\[\\{"id":"([0-9a-f-]{36})"').exec(
        JSON.stringify((await owner.get('/menu')).body),
      )?.[1],
      quantity: 2,
    },
  ],
});
const o2id = o2.body.id;
const o2num = String(o2.body.number);
const t3 = kp.getByRole('article', { name: `№${o2num}` });
check(
  '2-buyurtma oshxonada paydo bo‘ldi',
  !!(await waitFor(() => t3.isVisible(), 15000, 300)),
);
await t3.getByRole('button', { name: 'Rad etish' }).click();
await kp
  .getByRole('dialog')
  .getByLabel('Rad etish sababi')
  .fill('Masalliq tugagan');
await kp.getByRole('dialog').getByRole('button', { name: 'Rad etish' }).click();
check(
  'rad etilgan buyurtma «Rad etilgan» bo‘limida (yo‘qolmadi)',
  !!(await waitFor(
    async () =>
      /Rad etilgan/.test(
        await kp.getByRole('article', { name: `№${o2num}` }).innerText(),
      ),
    10000,
    300,
  )),
);
const rej = (await owner.get(`/orders/${o2id}`)).body;
check(
  'Kassa/Admin ko‘radigan buyurtmada sabab bor',
  rej.status === 'PLACED' && rej.kitchen.rejectReason === 'Masalliq tugagan',
);
check(
  'rad etilgan buyurtma TV navbatidan chiqdi',
  !!(await waitFor(
    async () => !(await tvText()).includes(`${o2num}`) || true,
    3000,
    500,
  )) && !(await tv.locator('.queue-columns').innerText()).includes(o2num),
);
const reopen = await owner.post(`/kitchen/orders/${o2id}/reopen`);
check(
  'kassir qayta yuborganda oshxona yana ko‘radi (Yangi)',
  reopen.status === 200 &&
    !!(await waitFor(
      async () =>
        /Yangi/.test(
          await kp.getByRole('article', { name: `№${o2num}` }).innerText(),
        ),
      10000,
      300,
    )),
);

// ---------------------------------------------------------------- reconnect: server IP/port gone and back

// ================================================================ upgrade checks
// ---- report files from the packaged server (libraries and fonts are inside)
const rawOf = async (path) => {
  const response = await fetch(`${BASE}/api${path}`, {
    headers: { origin: ORIGIN, cookie: owner.cookie() },
  });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer()),
  };
};
for (const [format, magic, mime] of [
  ['xlsx', 'PK', 'spreadsheetml'],
  ['docx', 'PK', 'wordprocessingml'],
  ['pdf', '%P', 'pdf'],
]) {
  const file = await rawOf(`/reports/export?format=${format}`);
  check(
    `paketdagi serverdan ${format.toUpperCase()} hisobot olindi`,
    file.status === 200 &&
      file.body.subarray(0, 2).toString() === magic &&
      String(file.type).includes(mime) &&
      file.body.length > 2000,
    `${file.status} ${file.body.length} bayt`,
  );
}

// ---- the Admin application downloads a report file by itself
await ap.goto(`${BASE}/hisobotlar`);
await ap.getByRole('link', { name: /Excel/ }).waitFor({ timeout: 30000 });
const [download] = await Promise.all([
  ap.waitForEvent('download', { timeout: 30000 }),
  ap.getByRole('link', { name: /Excel/ }).click(),
]);
const downloaded = fs.readFileSync(await download.path());
check(
  'Admin ilovasida «Excel» tugmasi hisobot faylini yuklaydi',
  /^hisobot-.*\.xlsx$/.test(download.suggestedFilename()) &&
    downloaded.subarray(0, 2).toString() === 'PK' &&
    downloaded.length > 2000,
  download.suggestedFilename(),
);

// ---- stock alert reaches the Admin screen (bell, pop-up) from the ledger
const item = await owner.post('/inventory/items', {
  name: 'Un',
  baseUnit: 'G',
  minStock: 1000,
  isActive: true,
  units: [],
});
await owner.post('/inventory/adjustments', {
  type: 'ADJUSTMENT',
  reason: 'Boshlang‘ich qoldiq',
  lines: [{ stockItemId: item.body.id, quantity: 5000 }],
});
await owner.post('/inventory/adjustments', {
  type: 'WASTE',
  reason: 'Isrof (sinov)',
  lines: [{ stockItemId: item.body.id, quantity: 4200 }],
});
const alerts = (await owner.get('/inventory/stock-alerts')).body.alerts;
check(
  'ombor ogohlantirishi serverda paydo bo‘ldi (LOW)',
  alerts.length === 1 && alerts[0].severity === 'LOW',
  JSON.stringify(alerts.map((a) => a.severity)),
);
const bell = await waitFor(
  async () =>
    (await ap.locator('.badge-dot').count()) > 0 &&
    (await ap.locator('.badge-dot').first().innerText()),
  70000,
  1000,
);
check(
  'Admin ilovasida 📦 belgisida raqam ko‘rindi',
  bell === '1',
  String(bell),
);

// ---- the approved-network rule (the apps are on this computer: loopback = approved)
const net = (await owner.get('/network/status')).body;
check(
  'tarmoq holati: ruxsat etilgan (shu kompyuter)',
  net.approved === true && net.via === 'LOCAL',
  JSON.stringify(net),
);

// ---- the TV application with a read-only display account
const roleList2 = (await owner.get('/roles')).body.roles;
const displayRole = roleList2.find((r) => r.systemKey === 'display')?.id;
check('«Mijoz ekrani (TV)» roli mavjud', !!displayRole);
await owner.post('/users', {
  username: 'ekran',
  password: PASS,
  displayName: 'EKRAN',
  roleIds: [displayRole],
  allBranches: true,
  branchIds: [],
});
const screenUser = client();
await screenUser.login('ekran');
await screenUser.post('/auth/password', {
  currentPassword: PASS,
  newPassword: `${PASS}x`,
});
check(
  'ekran hisobi navbatni ko‘ra oladi, buyurtmalarni ko‘ra olmaydi',
  (await screenUser.get('/queue')).status === 200 &&
    (await screenUser.get('/orders')).status === 403 &&
    (await screenUser.get('/reports/sales')).status === 403,
);
const tvApp = await launch(
  shellExe('tv', 'FastFoodTVTest.exe', 't6'),
  9514,
  'FastFood-TV-Test',
);
const tvFound = await waitFor(
  async () => /127\.0\.0\.1:8788/.test((await tvApp.main()).url()),
  90000,
  1000,
);
check('TV ilovasi serverni o‘zi topdi', !!tvFound);
{
  const p = await tvApp.main();
  await p.getByLabel('Biznes kodi').fill(SLUG);
  await p.getByLabel('Login').fill('ekran');
  await p.getByLabel('Parol').fill(`${PASS}x`);
  await p.getByRole('button', { name: 'Kirish', exact: true }).click();
  const onQueue = await waitFor(
    async () => /\/navbat/.test((await tvApp.main()).url()),
    40000,
    500,
  );
  check('TV ilovasi kirgach navbat ekranini ochdi', !!onQueue);
  await p.locator('.queue-columns').waitFor({ timeout: 20000 });
  const fullscreen = await p.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    sw: screen.width,
    sh: screen.height,
  }));
  check(
    'TV oynasi butun ekranni egalladi',
    fullscreen.w >= fullscreen.sw - 2 && fullscreen.h >= fullscreen.sh - 2,
    JSON.stringify(fullscreen),
  );
  const body = await p.evaluate(() => document.body.innerText);
  check(
    'TV da narx/xodim ma’lumoti yo‘q, navbat bor',
    /Tayyorlanmoqda|Tayyor/.test(body) && !/so‘m|Maxfiy|parol/i.test(body),
  );
  // the server goes away: the screen says so instead of looking live
  const before2 = await p.locator('.queue-offline').count();
  killServerOnly();
  const stale = await waitFor(
    async () =>
      (await p.locator('.queue-offline').count()) > 0 ||
      /Aloqa yo‘q/.test(
        (await tvApp.main()) &&
          (await p.evaluate(() => document.title + document.body.innerText)),
      ),
    60000,
    1000,
  );
  check(
    'aloqa uzilganda TV eskirgan ma’lumotni «jonli» deb ko‘rsatmaydi',
    before2 === 0 && !!stale,
  );
}

console.log(ok.every(Boolean) ? 'HAMMASI O‘TDI' : 'BA’ZI TEKSHIRUVLAR O‘TMADI');
await tvBrowser.close().catch(() => {});
killAll();
process.exit(ok.every(Boolean) ? 0 : 1);
