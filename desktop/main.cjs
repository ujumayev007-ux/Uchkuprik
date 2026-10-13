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
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const APP_PORT = 8787;
const PG_PORT = 54330;
const VERSION = app.getVersion();
const DATA = path.join(app.getPath('appData'), 'FastFood-Data');
const PGDATA = path.join(DATA, 'pgdata');
const BACKUPS = path.join(DATA, 'backups');
const LOGS = path.join(DATA, 'logs');
const RES = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, 'stage');
const PGBIN = path.join(RES, 'postgres', 'bin');
const SERVER = path.join(RES, 'app-server');

let win = null;
let api = null;
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

/** Secrets are generated once per computer and shared by every version. */
function secrets() {
  const file = path.join(DATA, 'secrets.json');
  const value = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {
        appSecretKey: crypto.randomBytes(32).toString('base64'),
        dbPassword: crypto.randomBytes(18).toString('base64url'),
      };
  let changed = !fs.existsSync(file);
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
  if (changed)
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
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
  const applied = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : [];
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
    fs.writeFileSync(
      path.join(DATA, 'applied-migrations.json'),
      JSON.stringify(applied),
    );
  } finally {
    await db.end();
  }
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
          { label: 'Telefonlar uchun manzil', click: showPhoneAddress },
          { label: 'Ma’lumotlar papkasi', click: () => shell.openPath(DATA) },
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

// Present only on the vendor's computer; customers' installs never have it.
const VENDOR_KEY = path.join(
  os.homedir(),
  '.fastfood',
  'vendor-license-private.pem',
);
const VENDOR_HISTORY = path.join(
  os.homedir(),
  '.fastfood',
  'licenses-issued.json',
);

function vendorHistory() {
  return fs.existsSync(VENDOR_HISTORY)
    ? JSON.parse(fs.readFileSync(VENDOR_HISTORY, 'utf8'))
    : [];
}

ipcMain.handle('vendor:history', () => vendorHistory());
ipcMain.handle('vendor:sign', (_event, input) => {
  if (!fs.existsSync(VENDOR_KEY)) throw new Error('Sotuvchi kaliti topilmadi');
  if (!/^FF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(input.installId || ''))
    throw new Error('O‘rnatish ID noto‘g‘ri (FF-XXXX-XXXX-XXXX)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt || ''))
    throw new Error('Sana noto‘g‘ri');
  if (!input.customer) throw new Error('Mijoz nomini kiriting');
  const payload = {
    v: 1,
    customer: String(input.customer).slice(0, 120),
    installId: input.installId,
    issuedAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    features: Array.isArray(input.features) ? input.features.map(String) : [],
    maxBranches: input.maxBranches ?? null,
    maxUsers: input.maxUsers ?? null,
    maxDevices: input.maxDevices ?? null,
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signature = crypto.sign(
    null,
    body,
    crypto.createPrivateKey(fs.readFileSync(VENDOR_KEY)),
  );
  const key = `${body.toString('base64url')}.${signature.toString('base64url')}`;
  const history = vendorHistory();
  history.push({ ...payload, key });
  fs.writeFileSync(VENDOR_HISTORY, JSON.stringify(history, null, 2));
  return key;
});

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

function openVendorPanel() {
  const panel = new BrowserWindow({
    width: 920,
    height: 860,
    title: 'Sotuvchi paneli',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(__dirname, 'vendor.html'));
}

async function boot() {
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    title: `FastFood ${VERSION}`,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  buildMenu();
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
    win.loadURL(`http://localhost:${APP_PORT}/`);
    return;
  }
  const keys = secrets();
  await initDatabase(keys.dbPassword);
  await backupIfUpgrading();
  await startPostgres();
  await migrate(keys.dbPassword);
  await ensureVendorLicense(keys);
  startServer(keys);
  if (!(await waitFor(`http://127.0.0.1:${APP_PORT}/api/health/ready`, 60)))
    throw new Error('Server ishga tushmadi. Jurnallarni tekshiring.');
  win.loadURL(`http://localhost:${APP_PORT}/`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
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
  if (stopping || !api) return;
  event.preventDefault();
  stopping = true;
  api.kill();
  (startedPostgres ? stopPostgres() : Promise.resolve()).finally(() =>
    app.quit(),
  );
});
app.on('window-all-closed', () => app.quit());
