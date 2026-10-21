// Real built Kassa (TEST) shell against fake restaurant servers + the real LAN beacon.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = 'C:/Users/PRESTIGE/fastfood-app';
const require = createRequire(`${root}/package.json`);
const { chromium } = require('@playwright/test');
const lan = require(`${root}/desktop/lan.cjs`);
const exe = process.argv[2];
const data = join(process.env.APPDATA, 'FastFood-Kassa-Test');
const settingsFile = join(data, 'admin-settings.json');
const ok = [];
const check = (n, v, d = '') => {
  ok.push(v);
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = () => {
  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Process FastFoodKassaTest -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0',
    ]);
  } catch {
    /* none */
  }
};
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find(
    (i) =>
      i &&
      i.family === 'IPv4' &&
      !i.internal &&
      i.address.startsWith('192.168.'),
  )?.address;
console.log('LAN IP', lanIp);

const tmp = (n) => fs.mkdtempSync(join(os.tmpdir(), `lan-${n}-`));
const idA = lan.loadIdentity({ dataDir: tmp('a'), safeStorage: null });
const idB = lan.loadIdentity({ dataDir: tmp('b'), safeStorage: null });
const idEvil = lan.loadIdentity({ dataDir: tmp('e'), safeStorage: null });

/** A fake restaurant server (app page + health) with a real beacon. */
function fakeServer({ identity, name, appPort, bind }) {
  const web = http.createServer((req, res) => {
    if (req.url.startsWith('/api/health/live')) {
      res.setHeader('content-type', 'application/json');
      return res.end('{"status":"ok","version":"test"}');
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><title>${name}</title><body>KASSA ${name}</body></html>`);
  });
  web.listen(appPort, '0.0.0.0');
  const beacon = lan.startBeacon({
    port: 47871,
    host: bind,
    identity,
    info: () => ({ name, port: appPort, ver: '1.14.3' }),
  });
  return {
    stop: () => {
      beacon.stop();
      web.closeAllConnections?.();
      web.close();
    },
  };
}

async function launch(port) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    env,
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
  return { child, browser };
}
// The main window = the page that is not the small status pill.
const pages = (b) => b.contexts().flatMap((c) => c.pages());
const mainPage = async (b) => {
  for (const p of pages(b))
    if (!(await p.url()).includes('status.html')) return p;
};
const pillPage = (b) => pages(b).find((p) => p.url().includes('status.html'));
async function waitFor(fn, ms = 40000, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(step);
  }
  return null;
}
const settings = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
};

kill();
fs.rmSync(settingsFile, { force: true });

// ---- 1) first start, ONE server: connects by itself
let A = fakeServer({
  identity: idA,
  name: 'TEST-A',
  appPort: 8788,
  bind: '127.0.0.1',
});
let app = await launch(9401);
let page = await waitFor(async () => await mainPage(app.browser));
const onKassa = await waitFor(
  async () =>
    /127\.0\.0\.1:8788\/kassa/.test((await mainPage(app.browser)).url()),
  60000,
);
check(
  '1-chi ishga tushirish: server o‘zi topildi va Kassa sahifasi ochildi',
  !!onKassa,
  (await mainPage(app.browser)).url(),
);
check(
  'juftlik (server kaliti) saqlandi',
  settings().serverId === idA.id && settings().url === 'http://127.0.0.1:8788',
);
const title = await waitFor(
  async () => (await mainPage(app.browser)).evaluate(() => 'x') && null,
  100,
);
const winTitle = execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process FastFoodKassaTest | Where-Object MainWindowTitle | Select-Object -First 1).MainWindowTitle',
  ],
  { encoding: 'utf8' },
).trim();
check('oyna sarlavhasida holat: «Ulandi»', /Ulandi/.test(winTitle), winTitle);

// ---- 2) server disappears -> "Aloqa yo'q" (pill + title)
A.stop();
const offTitle = await waitFor(
  () => {
    const t = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process FastFoodKassaTest | Where-Object MainWindowTitle | Select-Object -First 1).MainWindowTitle',
      ],
      { encoding: 'utf8' },
    ).trim();
    return /Aloqa yo/.test(t) ? t : null;
  },
  45000,
  1500,
);
check('server o‘chganda sarlavha «Aloqa yo‘q»', !!offTitle, offTitle || '');
const pill = pillPage(app.browser);
const pillText = pill ? await pill.evaluate(() => document.body.innerText) : '';
check(
  'pastda holat belgisi ko‘rinadi («Aloqa yo‘q · Avtomatik ulanish»)',
  /Aloqa yo‘q/.test(pillText),
  pillText.replace(/\s+/g, ' '),
);

// ---- 3) server returns on a NEW address/port -> found again by its key
A = fakeServer({
  identity: idA,
  name: 'TEST-A',
  appPort: 8790,
  bind: '127.0.0.1',
});
const moved = await waitFor(
  async () =>
    /127\.0\.0\.1:8790\/kassa/.test((await mainPage(app.browser)).url()),
  60000,
  1000,
);
check(
  'manzil o‘zgargach (yangi port) dastur serverni o‘zi qayta topdi',
  !!moved,
  (await mainPage(app.browser)).url(),
);
check('yangi manzil saqlandi', settings().url === 'http://127.0.0.1:8790');
const backTitle = await waitFor(
  () => {
    const t = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process FastFoodKassaTest | Where-Object MainWindowTitle | Select-Object -First 1).MainWindowTitle',
      ],
      { encoding: 'utf8' },
    ).trim();
    return /Ulandi/.test(t) ? t : null;
  },
  20000,
  1000,
);
check('qayta ulangach sarlavha «Ulandi»', !!backTitle, backTitle || '');

// ---- 4) a FAKE server (other key) on the same network: a paired app must ignore it
A.stop();
const Evil = fakeServer({
  identity: idEvil,
  name: 'SOXTA-SERVER',
  appPort: 8795,
  bind: '127.0.0.1',
});
await sleep(22000);
check(
  'soxta server (boshqa kalit) qabul qilinmadi: juftlik o‘zgarmadi',
  settings().serverId === idA.id && settings().url === 'http://127.0.0.1:8790',
  JSON.stringify(settings().url),
);
Evil.stop();
app.browser.close().catch(() => {});
kill();
await sleep(2500);

// ---- 5) restart while server is back on a third port: boot-time re-discovery
A = fakeServer({
  identity: idA,
  name: 'TEST-A',
  appPort: 8796,
  bind: '127.0.0.1',
});
app = await launch(9402);
const boot = await waitFor(
  async () =>
    /127\.0\.0\.1:8796\/kassa/.test((await mainPage(app.browser)).url()),
  60000,
  1000,
);
check(
  'dastur qayta yoqilganda eski manzil o‘lik bo‘lsa ham serverni o‘zi topdi',
  !!boot,
  (await mainPage(app.browser)).url(),
);
app.browser.close().catch(() => {});
kill();
await sleep(2500);
A.stop();

// ---- 6) TWO servers: the person chooses
fs.rmSync(settingsFile, { force: true });
A = fakeServer({
  identity: idA,
  name: 'RESTORAN-A',
  appPort: 8788,
  bind: '127.0.0.1',
});
const B = lanIp
  ? fakeServer({
      identity: idB,
      name: 'RESTORAN-B',
      appPort: 8789,
      bind: lanIp,
    })
  : null;
app = await launch(9403);
const chooser = await waitFor(
  async () => {
    const p = await mainPage(app.browser);
    const t = await p.evaluate(() => document.body.innerText);
    return /Bir nechta server topildi/.test(t) ? t : null;
  },
  60000,
  1000,
);
check(
  'ikkita server topilganda ro‘yxat chiqadi (o‘zi tanlamaydi)',
  !!chooser,
  (chooser || '').replace(/\s+/g, ' ').slice(0, 200),
);
if (chooser) {
  const p = await mainPage(app.browser);
  const count = await p.locator('#found li').count();
  check('ro‘yxatda 2 ta server', count === 2, String(count));
  await p
    .locator('#found li', { hasText: 'RESTORAN-B' })
    .locator('button')
    .click();
  const chose = await waitFor(
    async () => /8789\/kassa/.test((await mainPage(app.browser)).url()),
    30000,
    1000,
  );
  check(
    'tanlangan server (B) bilan ulandi',
    !!chose,
    (await mainPage(app.browser)).url(),
  );
  check('tanlov saqlandi', settings().serverId === idB.id);
}
app.browser.close().catch(() => {});
kill();
A.stop();
B?.stop();

// ---- 7) nothing on the network: a clear message (no crash)
fs.rmSync(settingsFile, { force: true });
app = await launch(9404);
const none = await waitFor(
  async () => {
    const p = await mainPage(app.browser);
    const t = await p.evaluate(() => document.body.innerText);
    return /server topilmadi/.test(t) ? t : null;
  },
  60000,
  1000,
);
check(
  'server yo‘q bo‘lsa tushunarli xabar: «Aloqa yo‘q: server topilmadi»',
  !!none,
);
app.browser.close().catch(() => {});
kill();

console.log(ok.every(Boolean) ? 'HAMMASI O‘TDI' : 'BA’ZI TEKSHIRUVLAR O‘TMADI');
process.exit(ok.every(Boolean) ? 0 : 1);
