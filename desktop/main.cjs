// FAST FOOD desktop: runs the bundled PostgreSQL and API server on this computer
// and shows the app in a window. Phones on the same Wi-Fi open http://<this-PC>:8787.
//
// Data lives OUTSIDE the install folder (%APPDATA%\FastFood-Data), so every version
// installed side by side uses the same database and nothing is lost on upgrade.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  clipboard,
  ipcMain,
  safeStorage,
  Tray,
  nativeImage,
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const safeJson = require('./safe-json.cjs');
const http = require('node:http');
const { registerUpdates } = require('./updates.cjs');
const alerts = require('./vendor-alerts.cjs');
const reports = require('./reports.cjs');
const lan = require('./lan.cjs');
const move = require('./move.cjs');

const RES = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, 'stage');
const PGBIN = path.join(RES, 'postgres', 'bin');
const SERVER = path.join(RES, 'app-server');

// A TEST build (channel.json baked by build.mjs) lives entirely apart from the
// production install: own data folder, ports, window title and no vendor watchers,
// so it can run next to the real app on the same computer without touching it.
const CHANNEL = (() => {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(SERVER, 'channel.json'), 'utf8'),
    );
    return value.channel === 'test' ? 'test' : 'production';
  } catch {
    return 'production';
  }
})();
const TEST = CHANNEL === 'test';
// Own Electron profile: the test build must not share the single-instance lock or
// window state with the production app running on the same computer.
if (TEST)
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), 'FastFood-Test-App'),
  );

// FASTFOOD_PORT / FASTFOOD_PG_PORT let a second copy run next to the installed one
// (support and release checks) without touching it.
const APP_PORT = Number(process.env.FASTFOOD_PORT) || (TEST ? 8788 : 8787);
const PG_PORT = Number(process.env.FASTFOOD_PG_PORT) || (TEST ? 54331 : 54330);
const VERSION = app.getVersion();
// FASTFOOD_DATA_DIR / FASTFOOD_VENDOR_DIR point a run at other folders (support, testing).
const DATA =
  process.env.FASTFOOD_DATA_DIR ||
  path.join(
    app.getPath('appData'),
    TEST ? 'FastFood-Test-Data' : 'FastFood-Data',
  );
const PGDATA = path.join(DATA, 'pgdata');
const BACKUPS = path.join(DATA, 'backups');
const LOGS = path.join(DATA, 'logs');

let win = null;
let tray = null;
// Started by Windows at sign-in (see enableAutoStart): run without showing the window.
const HIDDEN = process.argv.includes('--hidden');
// True once the user really quits (tray «Chiqish», Windows shutdown): only then the
// window may close; before that closing it just hides it and the server keeps serving.
let quitting = false;
let api = null;
let beacon = null;
let startedPostgres = false;

fs.mkdirSync(LOGS, { recursive: true });
const logFile = path.join(LOGS, 'desktop.log');
const log = (message) =>
  fs.appendFileSync(
    logFile,
    `${new Date().toISOString()} [${VERSION}] ${message}\n`,
  );

function run(file, args, options = {}) {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, ...options },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(`${path.basename(file)}: ${stderr || error.message}`),
            )
          : resolve(stdout),
    ),
  );
}

/**
 * Secrets are generated once per computer and shared by every version. They are kept
 * encrypted with the operating system's user key (Windows DPAPI via safeStorage);
 * the plaintext file of earlier versions is migrated and removed once the encrypted
 * copy has been read back successfully.
 */
function secrets() {
  const plain = path.join(DATA, 'secrets.json');
  const sealed = path.join(DATA, 'secrets.enc');
  const secure =
    process.env.FASTFOOD_NO_SECURE_STORAGE !== '1' &&
    safeStorage.isEncryptionAvailable();
  let value = null;
  if (fs.existsSync(sealed)) {
    if (!secure)
      throw new Error(
        'Maxfiy kalitlar Windows foydalanuvchisi bilan himoyalangan. Shu foydalanuvchi bilan kiring.',
      );
    try {
      value = JSON.parse(safeStorage.decryptString(fs.readFileSync(sealed)));
    } catch {
      throw new Error(
        'Maxfiy kalitlarni ochib bo‘lmadi (boshqa Windows foydalanuvchisi yoki kompyuter).',
      );
    }
  } else if (fs.existsSync(plain)) {
    value = JSON.parse(fs.readFileSync(plain, 'utf8'));
  }
  const fresh = value === null;
  value ??= {
    appSecretKey: crypto.randomBytes(32).toString('base64'),
    dbPassword: crypto.randomBytes(18).toString('base64url'),
  };
  let changed = fresh;
  // Licences are bound to this ID; it survives upgrades because it lives in DATA.
  if (!value.installId) {
    const hex = crypto.randomBytes(6).toString('hex').toUpperCase();
    value.installId = `FF-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
    changed = true;
  }
  if (!value.installedAt) {
    value.installedAt = new Date().toISOString();
    changed = true;
  }
  // A reinstall (even after deleting the data folder) keeps the first demo date.
  const first = alerts.firstInstallDate(value.installedAt);
  if (first !== value.installedAt) {
    value.installedAt = first;
    changed = true;
  }
  if (secure) {
    if (changed || !fs.existsSync(sealed) || fs.existsSync(plain)) {
      const text = JSON.stringify(value);
      fs.writeFileSync(sealed, safeStorage.encryptString(text), {
        mode: 0o600,
      });
      // Remove the plaintext copy only after the sealed one decrypts correctly.
      const check = safeStorage.decryptString(fs.readFileSync(sealed));
      if (check === text) fs.rmSync(plain, { force: true });
    }
  } else if (changed)
    fs.writeFileSync(plain, JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}

/** Central-control settings baked into this build (public data only, no secrets). */
function controlSettings() {
  try {
    const file = path.join(SERVER, 'control.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const secure =
      String(parsed.url || '').startsWith('https://') ||
      (TEST &&
        (String(parsed.url).startsWith('http://127.0.0.1:') ||
          String(parsed.url).startsWith('http://localhost:')));
    if (!secure || !parsed.publicKey) return null;
    // The address can be changed without rebuilding (server migration): an address in
    // %APPDATA%\FastFood-Data\control-server.json (or FASTFOOD_CONTROL_URL) wins over
    // the one baked into this build. The public key stays the same: a moved server
    // keeps its signing key. Only https (loopback http in test builds) is accepted.
    let url = String(parsed.url).replace(/[/]+$/, '');
    try {
      const override = String(
        process.env.FASTFOOD_CONTROL_URL ||
          JSON.parse(
            fs.readFileSync(path.join(DATA, 'control-server.json'), 'utf8'),
          ).url ||
          '',
      )
        .trim()
        .replace(/[/]+$/, '');
      const allowed =
        override.startsWith('https://') ||
        (TEST &&
          /^http:[/][/](127[.]0[.]0[.]1|localhost):[0-9]+$/.test(override));
      if (override && allowed) url = override;
    } catch {
      /* no override file */
    }
    return { url, publicKey: parsed.publicKey };
  } catch {
    return null;
  }
}

/**
 * Device identity of this installation: an Ed25519 key generated here and kept
 * encrypted with the operating system's user key. The backend signs every message
 * to the central server with it; the private key is never written in plaintext.
 */
function deviceKey() {
  if (
    process.env.FASTFOOD_NO_SECURE_STORAGE === '1' ||
    !safeStorage.isEncryptionAvailable()
  )
    return null;
  const file = path.join(DATA, 'device-key.enc');
  if (fs.existsSync(file))
    try {
      return safeStorage.decryptString(fs.readFileSync(file));
    } catch {
      return null;
    }
  // Moved from another computer: keep the same identity (and so the same licence).
  const moved = path.join(DATA, 'device-key.pem');
  if (fs.existsSync(moved)) {
    const pem = fs.readFileSync(moved, 'utf8');
    fs.writeFileSync(file, safeStorage.encryptString(pem), { mode: 0o600 });
    if (safeStorage.decryptString(fs.readFileSync(file)) === pem)
      fs.rmSync(moved, { force: true });
    return pem;
  }
  const pair = crypto.generateKeyPairSync('ed25519');
  const pem = pair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  fs.writeFileSync(file, safeStorage.encryptString(pem), { mode: 0o600 });
  return pem;
}

function ping(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function initDatabase(password) {
  if (fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) return;
  log('initdb');
  const pwfile = path.join(DATA, '.pw');
  fs.writeFileSync(pwfile, password);
  try {
    await run(path.join(PGBIN, 'initdb.exe'), [
      '-D',
      PGDATA,
      '-U',
      'fastfood',
      `--pwfile=${pwfile}`,
      '-E',
      'UTF8',
      '--locale=C',
      '--auth=scram-sha-256',
    ]);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
}

async function postgresRunning() {
  try {
    await run(path.join(PGBIN, 'pg_ctl.exe'), ['-D', PGDATA, 'status']);
    return true;
  } catch {
    return false;
  }
}

async function startPostgres() {
  if (await postgresRunning()) return;
  // The server inherits pg_ctl's handles, so wait for pg_ctl's exit code only
  // (stdio ignored) instead of its output streams, which would never close.
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(PGBIN, 'pg_ctl.exe'),
      [
        '-D',
        PGDATA,
        '-l',
        path.join(LOGS, 'postgres.log'),
        '-w',
        '-t',
        '60',
        '-o',
        `-p ${PG_PORT} -c listen_addresses=127.0.0.1`,
        'start',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`PostgreSQL ishga tushmadi (kod ${code})`)),
    );
  });
  startedPostgres = true;
}

async function stopPostgres() {
  if (!(await postgresRunning())) return;
  await run(path.join(PGBIN, 'pg_ctl.exe'), [
    '-D',
    PGDATA,
    '-m',
    'fast',
    '-w',
    'stop',
  ]).catch(() => undefined);
}

function migrationNames() {
  const dir = path.join(SERVER, 'backend', 'prisma', 'migrations');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Before this version applies new migrations, keep a full copy of the database
 * (taken while PostgreSQL is stopped). The last five copies are kept.
 */
async function backupIfUpgrading() {
  const stateFile = path.join(DATA, 'applied-migrations.json');
  // A damaged list (power cut) is moved aside; the list is rebuilt after migrating.
  const read = safeJson.readJson(stateFile, [], (file, moved) =>
    log(`damaged file moved aside: ${file} -> ${moved}`),
  );
  const applied = Array.isArray(read) ? read : [];
  const pending = migrationNames().filter((name) => !applied.includes(name));
  if (pending.length === 0 || applied.length === 0) return;
  await stopPostgres();
  const target = path.join(
    BACKUPS,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-before-${VERSION}`,
  );
  log(`backup ${target}`);
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.cpSync(PGDATA, target, { recursive: true });
  const all = fs.readdirSync(BACKUPS).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 5)))
    fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
}

/** Applies migrations exactly like `prisma migrate deploy` (same bookkeeping table). */
async function migrate(password) {
  const { Client } = require('pg');
  const admin = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'fastfood',
    password,
    database: 'postgres',
  });
  await admin.connect();
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = 'fastfood'",
  );
  if (exists.rowCount === 0)
    await admin.query(
      "CREATE DATABASE fastfood ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0",
    );
  await admin.end();

  const db = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'fastfood',
    password,
    database: 'fastfood',
  });
  await db.connect();
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
    const done = new Set(
      (
        await db.query(
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
        )
      ).rows.map((row) => row.migration_name),
    );
    const dir = path.join(SERVER, 'backend', 'prisma', 'migrations');
    for (const name of migrationNames()) {
      if (done.has(name)) continue;
      const sql = fs.readFileSync(
        path.join(dir, name, 'migration.sql'),
        'utf8',
      );
      log(`migrate ${name}`);
      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query(
          'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ($1, $2, now(), $3, 1)',
          [
            crypto.randomUUID(),
            crypto.createHash('sha256').update(sql).digest('hex'),
            name,
          ],
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw new Error(`Migratsiya ${name}: ${error.message}`);
      }
    }
    const applied = (
      await db.query(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
      )
    ).rows.map((row) => row.migration_name);
    safeJson.writeJson(
      path.join(DATA, 'applied-migrations.json'),
      JSON.stringify(applied),
    );
  } finally {
    await db.end();
  }
}

/** Status document URL baked into this build by the vendor (remote renewals/blocking). */
function licenseStatusUrl() {
  const file = path.join(SERVER, 'license-status-url.txt');
  const url = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return url.startsWith('https://') ? { LICENSE_STATUS_URL: url } : {};
}

function controlEnv() {
  const settings = controlSettings();
  if (!settings) return {};
  const pem = deviceKey();
  return {
    CONTROL_URL: settings.url,
    CONTROL_PUBLIC_KEY: settings.publicKey,
    ...(pem ? { CONTROL_DEVICE_KEY: Buffer.from(pem).toString('base64') } : {}),
  };
}

function startServer(keys) {
  const out = fs.openSync(path.join(LOGS, 'server.log'), 'a');
  api = spawn(
    process.execPath,
    [path.join(SERVER, 'backend', 'dist', 'server.js')],
    {
      cwd: path.join(SERVER, 'backend'),
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'development',
        HOST: '0.0.0.0',
        PORT: String(APP_PORT),
        APP_ORIGIN: `http://localhost:${APP_PORT}`,
        ALLOW_SAME_HOST_ORIGIN: 'true',
        SELF_HOSTED: 'true',
        INSTALL_ID: keys.installId,
        INSTALLED_AT: keys.installedAt,
        ...licenseStatusUrl(),
        ...controlEnv(),
        SERVE_FRONTEND: 'true',
        APP_SECRET_KEY: keys.appSecretKey,
        DATABASE_URL: `postgresql://fastfood:${encodeURIComponent(keys.dbPassword)}@127.0.0.1:${PG_PORT}/fastfood?schema=public`,
        RENDER_GIT_COMMIT: VERSION,
        LOG_LEVEL: 'warn',
      },
    },
  );
  api.on('exit', (code) => log(`server exited ${code}`));
}

/**
 * Daily logical backup with a restore check: the backend dumps every table, restores
 * the file into a scratch database and compares row counts. A copy that does not
 * restore is deleted and reported in the log. The last seven copies are kept.
 */
function scheduleBackups(keys) {
  const cli = path.join(SERVER, 'backend', 'dist', 'cli', 'backup.js');
  if (!fs.existsSync(cli)) return;
  const run = () => {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUPS, `daily-${day}.ndjson.gz`);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(BACKUPS, { recursive: true });
    const child = spawn(process.execPath, [cli, 'create', file], {
      cwd: path.join(SERVER, 'backend'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'development',
        APP_ORIGIN: `http://localhost:${APP_PORT}`,
        APP_SECRET_KEY: keys.appSecretKey,
        DATABASE_URL: `postgresql://fastfood:${encodeURIComponent(keys.dbPassword)}@127.0.0.1:${PG_PORT}/fastfood?schema=public`,
        LOG_LEVEL: 'warn',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => {
      const last = output.trim().split(/\r?\n/).pop();
      log(`backup ${code === 0 ? 'ok' : 'FAILED'}: ${last}`);
      if (code !== 0) fs.rmSync(file, { force: true });
      const copies = fs
        .readdirSync(BACKUPS)
        .filter((name) => /^daily-.*.ndjson.gz$/.test(name))
        .sort();
      for (const old of copies.slice(0, Math.max(0, copies.length - 7)))
        fs.rmSync(path.join(BACKUPS, old), { force: true });
    });
  };
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, 6 * 60 * 60_000).unref();
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await ping(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => `http://${item.address}:${APP_PORT}`);
}

function showPhoneAddress() {
  const addresses = lanAddresses();
  if (addresses[0]) clipboard.writeText(addresses[0]);
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Telefonlar uchun manzil',
    message: addresses.length
      ? addresses.join('\n')
      : 'Kompyuter tarmoqqa ulanmagan.',
    detail:
      'Telefon shu Wi‑Fi tarmog‘ida bo‘lsin. FastFood ilovasida (APK) shu manzilni kiriting. Birinchi manzil nusxalandi.\n\nAndroid ilovasini telefonda yuklab olish: ' +
      (addresses[0] ? addresses[0] + '/downloads/FastFood.apk' : ''),
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'FastFood',
        submenu: [
          { label: 'Avtomatik ulanish', click: () => void showAutoConnect() },
          { label: 'Telefonlar uchun manzil', click: showPhoneAddress },
          { label: 'Ma’lumotlar papkasi', click: () => shell.openPath(DATA) },
          {
            label: 'Serverni boshqa kompyuterga ko‘chirish…',
            click: () => void moveServer(),
          },
          ...(fs.existsSync(VENDOR_KEY)
            ? [
                {
                  label: 'Sotuvchi paneli (litsenziyalar)',
                  click: openVendorPanel,
                },
              ]
            : []),
          { type: 'separator' },
          { label: 'Yangilash (F5)', role: 'reload' },
          { label: 'To‘liq ekran', role: 'togglefullscreen' },
          { type: 'separator' },
          { label: 'Chiqish', role: 'quit' },
        ],
      },
      {
        label: 'Yordam',
        submenu: [
          { label: `Versiya ${VERSION}`, enabled: false },
          { label: 'Jurnallar papkasi', click: () => shell.openPath(LOGS) },
        ],
      },
    ]),
  );
}

// ------------------------------------------- automatic connection (LAN)

const LAN_PORT =
  Number(process.env.FASTFOOD_LAN_PORT) ||
  (TEST ? lan.TEST_DISCOVERY_PORT : lan.DISCOVERY_PORT);
const LAN_ASKED = path.join(DATA, 'lan-firewall.json');

/** Other computers (Kassa, Ofitsiant, Admin) find this server by itself. */
function startLan() {
  if (beacon) return;
  try {
    const identity = lan.loadIdentity({ dataDir: DATA, safeStorage });
    beacon = lan.startBeacon({
      port: LAN_PORT,
      identity,
      info: () => ({ name: os.hostname(), port: APP_PORT, ver: VERSION }),
      log,
    });
    log(`lan beacon on ${LAN_PORT}, server ${beacon.fingerprint}`);
  } catch (error) {
    // Automatic connection must never stop the restaurant application from starting.
    log(`lan beacon unavailable: ${error.message}`);
  }
}

async function enableNetwork() {
  const result = await lan.enableFirewall({
    exe: process.execPath,
    appPort: APP_PORT,
    discoveryPort: LAN_PORT,
  });
  log(`lan firewall rules ${result.ok ? 'added' : 'not added'}`);
  return result.ok;
}

/** Once a day at most, until the network permission is given. */
async function askNetworkPermission() {
  if (TEST || process.platform !== 'win32') return;
  // Started silently: ask when the window is opened from the tray instead.
  if (!win || !win.isVisible()) return;
  try {
    if ((await lan.firewallState()).ok) return;
    const today = new Date().toISOString().slice(0, 10);
    const last = safeJson.readJson?.(LAN_ASKED, {}) ?? {};
    if (last.asked === today) return;
    fs.writeFileSync(LAN_ASKED, JSON.stringify({ asked: today }));
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Avtomatik ulanish',
      message:
        'Boshqa kompyuterlar bu serverga o‘zi ulanishi uchun ruxsat kerak',
      detail:
        'Kassa, Ofitsiant va Admin kompyuterlari shu serverni avtomatik topadi. Buning uchun Windows’ga ikkita tor qoida qo‘shiladi: faqat FastFood dasturi uchun va faqat shu Wi‑Fi/LAN tarmog‘i ichida. Xavfsizlik devori o‘chirilmaydi. Windows ruxsat so‘raydi — «Ha» ni bosing.',
      buttons: ['Ruxsat berish', 'Keyinroq'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await enableNetwork();
  } catch (error) {
    log(`network permission: ${error.message}`);
  }
}

async function showAutoConnect() {
  const firewall = await lan.firewallState();
  const addresses = lanAddresses();
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Avtomatik ulanish',
    message: beacon
      ? 'Bu kompyuter server sifatida o‘zini tarmoqda e‘lon qilyapti'
      : 'Avtomatik ulanish ishga tushmagan',
    detail: [
      `Server nomi: ${os.hostname()}`,
      beacon ? `Xavfsizlik kodi: ${beacon.fingerprint}` : '',
      addresses[0]
        ? `Hozirgi manzil: ${addresses[0]}`
        : 'Kompyuter tarmoqqa ulanmagan.',
      firewall.ok
        ? 'Tarmoq ruxsati: berilgan.'
        : 'Tarmoq ruxsati: berilmagan — boshqa kompyuterlar buni topa olmasligi mumkin.',
      '',
      'Kassa, Ofitsiant va Admin dasturlarida «Avtomatik ulanish» tugmasini bosing: ular shu kodni ko‘rsatadi.',
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: firewall.ok ? ['Yopish'] : ['Tarmoq ruxsatini berish', 'Yopish'],
    defaultId: 0,
  });
  if (!firewall.ok && response === 0) await enableNetwork();
}

// ------------------------------------------------------------ AnyDesk

const ANYDESK_PATHS = [
  'C:\\Program Files (x86)\\AnyDesk\\AnyDesk.exe',
  'C:\\Program Files\\AnyDesk\\AnyDesk.exe',
  path.join(os.homedir(), 'Downloads', 'AnyDesk.exe'),
  path.join(os.homedir(), 'Desktop', 'AnyDesk.exe'),
];

ipcMain.handle('anydesk:open', async () => {
  const exe = ANYDESK_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!exe) {
    shell.openExternal('https://anydesk.com/download');
    return { installed: false, id: null };
  }
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  // Installed AnyDesk can report this computer's ID for the vendor.
  const id = await run(exe, ['--get-id'], { timeout: 8000 })
    .then((output) => output.trim().match(/\d{6,12}/)?.[0] ?? null)
    .catch(() => null);
  return { installed: true, id };
});

// --------------------------------------------------- vendor licence panel

// The vendor tools live in vendor-ipc.cjs (shared with the Owner app); they only
// work on the vendor's computer, which holds the private signing key.
const vendorTools = require('./vendor-ipc.cjs').registerVendor({
  // A test build never uses the production vendor folder or its signing key.
  vendorDir: TEST ? path.join(DATA, 'vendor-test') : undefined,
  ipcMain,
  dialog,
  getWindow: () => win,
  log,
});
const {
  VENDOR_DIR,
  VENDOR_KEY,
  vendorState,
  saveVendorState,
  paymentWatch,
  reportWatch,
  isVendorComputer,
  ALL_FEATURES,
} = vendorTools;

/**
 * The vendor's own computer (it holds the private key) never needs a licence from
 * anyone: it signs itself a long-term licence with every feature enabled.
 */
async function ensureVendorLicense(keys) {
  if (!fs.existsSync(VENDOR_KEY)) return;
  const { Client } = require('pg');
  const db = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'fastfood',
    password: keys.dbPassword,
    database: 'fastfood',
  });
  await db.connect();
  try {
    const row = (await db.query('SELECT key FROM app_license WHERE id = 1'))
      .rows[0];
    if (row) {
      try {
        const current = JSON.parse(
          Buffer.from(row.key.split('.')[0], 'base64url').toString('utf8'),
        );
        const yearAhead = new Date(Date.now() + 365 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        if (
          current.installId === keys.installId &&
          current.expiresAt > yearAhead
        )
          return;
      } catch {
        // Unreadable key: replace it below.
      }
    }
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 10);
    const payload = {
      v: 1,
      customer: 'Sotuvchi (shaxsiy nusxa)',
      installId: keys.installId,
      issuedAt: new Date().toISOString(),
      expiresAt: expires.toISOString().slice(0, 10),
      features: [
        'inventory',
        'delivery',
        'online_ordering',
        'loyalty',
        'kitchen_printing',
        'online_payments',
        'hr',
        'finance',
        'multi_brand',
        'franchise',
        'operations',
        'developer_api',
      ],
      maxBranches: null,
      maxUsers: null,
      maxDevices: null,
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = crypto.sign(
      null,
      body,
      crypto.createPrivateKey(fs.readFileSync(VENDOR_KEY)),
    );
    const key = `${body.toString('base64url')}.${signature.toString('base64url')}`;
    await db.query(
      `INSERT INTO app_license (id, key, "lastSeenAt", "updatedAt") VALUES (1, $1, now(), now())
       ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, "updatedAt" = now()`,
      [key],
    );
    log('vendor licence issued for this computer');
  } finally {
    await db.end();
  }
}

/** The vendor tools live inside the app (left menu: Sotuvchi paneli). */
registerUpdates({
  statusUrl: () => licenseStatusUrl().LICENSE_STATUS_URL ?? null,
  log,
  controlPublicKey: controlSettings()?.publicKey ?? null,
  // Staged releases announced by the central server through the local backend.
  controlUpdate: async () => {
    const response = await fetch(
      `http://127.0.0.1:${APP_PORT}/api/control/link/update-info`,
      { signal: AbortSignal.timeout(5000) },
    );
    return response.ok ? response.json() : null;
  },
});

function openVendorPanel() {
  if (win) win.loadURL(`http://localhost:${APP_PORT}/sotuvchi`);
}

/** Brings the (possibly hidden) window back. */
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  void askNetworkPermission();
}

/** Tray icon: the server keeps running in the background while the window is closed. */
async function createTray() {
  if (tray) return;
  const icon = await app
    .getFileIcon(process.execPath, { size: 'small' })
    .catch(() => nativeImage.createEmpty());
  tray = new Tray(icon);
  tray.setToolTip(
    TEST ? `FastFood TEST ${VERSION} — server` : `FastFood ${VERSION} — server`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ochish', click: showWindow },
      {
        label: 'Server manzili',
        click: () => {
          showWindow();
          showPhoneAddress();
        },
      },
      { type: 'separator' },
      { label: 'Chiqish', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', showWindow);
}

/**
 * Starts silently with Windows after this user signs in (production installs only; a
 * support or test run with its own data folder never registers itself).
 */
function enableAutoStart() {
  if (!app.isPackaged || TEST || process.env.FASTFOOD_DATA_DIR) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  } catch (error) {
    log(`autostart: ${error.message}`);
  }
}

/**
 * "Serverni boshqa kompyuterga ko‘chirish": stops the server safely, writes a move package
 * (data + keys) and switches the server off on this computer, so that only one server runs.
 */
async function moveServer() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Bekor qilish', 'Davom etish'],
    defaultId: 0,
    cancelId: 0,
    title: 'Serverni ko‘chirish',
    message: 'Server boshqa kompyuterga ko‘chiriladi',
    detail:
      'Server to‘xtatiladi, barcha ma’lumotlar va kalitlar paketga yoziladi. Shundan so‘ng bu kompyuterdagi server ishlamaydi (ikki server bir vaqtda ishlamasligi uchun). Paketni yangi kompyuterga o‘tkazing va yo‘riqnomaga amal qiling.',
  });
  if (response !== 1) return;
  const chosen = await dialog.showOpenDialog(win, {
    title: 'Paket qayerga yozilsin?',
    defaultPath: app.getPath('desktop'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const dest = path.join(chosen.filePaths[0], `FastFood-Kochirish-${stamp}`);
  try {
    const keys = secrets();
    const identity = lan.loadIdentity({ dataDir: DATA, safeStorage });
    const pem = deviceKey();
    stopping = true;
    beacon?.stop();
    api?.kill();
    if (startedPostgres) await stopPostgres();
    fs.mkdirSync(dest, { recursive: true });
    move.exportPackage({
      dataDir: DATA,
      dest,
      secrets: keys,
      lanIdentity: identity,
      deviceKeyPem: pem,
      version: VERSION,
    });
    move.markMoved(DATA, { to: dest });
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch {
      /* not registered */
    }
    log(`server moved: package written to ${dest}`);
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Ko‘chirish paketi tayyor',
      detail: `${dest}\n\nYo‘riqnoma: KOCHIRISH-YORIQNOMA.txt. Paketda maxfiy kalitlar bor — ishdan keyin o‘chiring.`,
    });
    shell.showItemInFolder(path.join(dest, 'KOCHIRISH-YORIQNOMA.txt'));
  } catch (error) {
    log(`move failed: ${error.message}`);
    dialog.showErrorBox('Ko‘chirib bo‘lmadi', error.message);
  }
  quitting = true;
  app.exit(0);
}

async function boot() {
  // Moved to another computer: this copy must not run next to the new one.
  const moved = move.movedInfo(DATA);
  if (moved) {
    dialog.showErrorBox(
      'Server boshqa kompyuterga ko‘chirilgan',
      `Bu server ${String(moved.at || '')
        .slice(0, 16)
        .replace(
          'T',
          ' ',
        )} da boshqa kompyuterga ko‘chirilgan. Ikki server bir vaqtda ishlasa, ma’lumotlar ikkiga bo‘linib ketadi.\n\nQayta yoqish kerak bo‘lsa: ${path.join(DATA, 'moved.json')} faylini o‘chiring.`,
    );
    app.exit(0);
    return;
  }
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    show: !HIDDEN,
    title: TEST ? `FastFood TEST ${VERSION}` : `FastFood ${VERSION}`,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  buildMenu();
  // Closing the window hides it; the server stops only through «Chiqish».
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // Windows shutdown, restart or sign-out must not be held up by the hidden window.
  win.on('session-end', () => {
    quitting = true;
  });
  await createTray();
  enableAutoStart();
  win.loadFile(path.join(__dirname, 'loading.html'));
  // Links that leave the app (e.g. printed receipts) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${APP_PORT}`))
      shell.openExternal(url);
    else return { action: 'allow' };
    return { action: 'deny' };
  });

  const live = `http://127.0.0.1:${APP_PORT}/api/health/live`;
  // Another FastFood version already serves this computer: use it, never a second database.
  if (await ping(live)) {
    log('server already running; attaching');
    startLan();
    win.loadURL(`http://localhost:${APP_PORT}/`);
    void askNetworkPermission();
    return;
  }
  const keys = secrets();
  // A device key brought by a move package is sealed at once (never left in plain form).
  if (fs.existsSync(path.join(DATA, 'device-key.pem'))) deviceKey();
  await initDatabase(keys.dbPassword);
  await backupIfUpgrading();
  await startPostgres();
  await migrate(keys.dbPassword);
  await ensureVendorLicense(keys);
  startServer(keys);
  if (isVendorComputer()) {
    // The vendor tools must never stop the restaurant application from starting.
    try {
      paymentWatch.start();
      const state = vendorState();
      if (reports.ensureReportKeys(VENDOR_DIR, state)) saveVendorState(state);
      reportWatch.start();
    } catch (error) {
      log(`vendor tools unavailable: ${error.message}`);
    }
  } else
    reports.startReporting({
      configFile: path.join(SERVER, 'report.json'),
      keys,
      version: VERSION,
      dbConfig: {
        host: '127.0.0.1',
        port: PG_PORT,
        user: 'fastfood',
        password: keys.dbPassword,
        database: 'fastfood',
      },
      log,
    });
  if (!(await waitFor(`http://127.0.0.1:${APP_PORT}/api/health/ready`, 60)))
    throw new Error('Server ishga tushmadi. Jurnallarni tekshiring.');
  scheduleBackups(keys);
  startLan();
  win.loadURL(`http://localhost:${APP_PORT}/`);
  void askNetworkPermission();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Opening FastFood again (desktop icon) shows the running server's window.
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() =>
    boot().catch((error) => {
      log(`boot failed: ${error.stack || error.message}`);
      dialog.showErrorBox(
        'FastFood ishga tushmadi',
        `${error.message}\n\nJurnal: ${logFile}`,
      );
      app.quit();
    }),
  );
}

let stopping = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (stopping || !api) return;
  event.preventDefault();
  stopping = true;
  beacon?.stop();
  api.kill();
  (startedPostgres ? stopPostgres() : Promise.resolve()).finally(() =>
    app.quit(),
  );
});
app.on('window-all-closed', () => app.quit());
