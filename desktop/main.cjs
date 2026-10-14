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
const { registerUpdates } = require('./updates.cjs');
const alerts = require('./vendor-alerts.cjs');
const reports = require('./reports.cjs');

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
  // A reinstall (even after deleting the data folder) keeps the first demo date.
  const first = alerts.firstInstallDate(value.installedAt);
  if (first !== value.installedAt) {
    value.installedAt = first;
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

/** Status document URL baked into this build by the vendor (remote renewals/blocking). */
function licenseStatusUrl() {
  const file = path.join(SERVER, 'license-status-url.txt');
  const url = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return url.startsWith('https://') ? { LICENSE_STATUS_URL: url } : {};
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
const VENDOR_DIR = path.join(os.homedir(), '.fastfood');
const VENDOR_KEY = path.join(VENDOR_DIR, 'vendor-license-private.pem');
const VENDOR_HISTORY = path.join(VENDOR_DIR, 'licenses-issued.json');
const VENDOR_STATE = path.join(VENDOR_DIR, 'vendor.json');
const ALL_FEATURES = [
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
];

function vendorHistory() {
  return fs.existsSync(VENDOR_HISTORY)
    ? JSON.parse(fs.readFileSync(VENDOR_HISTORY, 'utf8'))
    : [];
}

/** Vendor state: GitHub gist for remote control and one entry per customer install. */
function vendorState() {
  const state = fs.existsSync(VENDOR_STATE)
    ? JSON.parse(fs.readFileSync(VENDOR_STATE, 'utf8'))
    : { customers: {} };
  state.customers ??= {};
  // Customers from licences issued before the customer list existed.
  for (const row of vendorHistory())
    if (
      !state.customers[row.installId] ||
      state.customers[row.installId].issuedAt < row.issuedAt
    )
      state.customers[row.installId] = {
        ...(state.customers[row.installId] ?? { blocked: false }),
        ...row,
      };
  return state;
}

function saveVendorState(state) {
  fs.writeFileSync(VENDOR_STATE, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function signLicense(input, statusUrl) {
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
    features: Array.isArray(input.features)
      ? input.features.map(String)
      : ALL_FEATURES,
    maxBranches: input.maxBranches ?? null,
    maxUsers: input.maxUsers ?? null,
    maxDevices: input.maxDevices ?? null,
    ...(statusUrl ? { statusUrl } : {}),
    hiddenMenus: Array.isArray(input.hiddenMenus)
      ? input.hiddenMenus
          .map(String)
          .filter((item) => /^\/[a-z0-9/-]*$/.test(item))
      : [],
    // Locked restaurant settings and permissions removed for everyone (SUPER_OWNER).
    settings: {
      orders: Object.fromEntries(
        Object.entries(input.settings?.orders ?? {}).filter(
          ([key, value]) =>
            /^[a-zA-Z]{1,40}$/.test(key) && typeof value === 'boolean',
        ),
      ),
    },
    deniedPermissions: Array.isArray(input.deniedPermissions)
      ? input.deniedPermissions
          .map(String)
          .filter((key) => /^[a-z]+\.[a-z.]+$/.test(key))
      : [],
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
  return { payload, key };
}

async function github(state, method, url, body) {
  const response = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'FastFood-Vendor',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'GitHub token noto‘g‘ri yoki muddati o‘tgan'
        : `GitHub xatosi ${response.status}`,
    );
  return response.json();
}

const STATUS_FILE = 'fastfood-licenses.txt';

/** Signs and uploads the status document every customer app polls. */
async function publishStatus(state) {
  if (!state.githubToken || !state.gistId) return { published: false };
  const entries = {};
  for (const installId of Object.keys(state.blockedInstalls ?? {}))
    entries[installId] = { blocked: true };
  for (const [installId, customer] of Object.entries(state.customers))
    entries[installId] = {
      blocked: !!customer.blocked,
      ...(customer.key ? { key: customer.key } : {}),
    };
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      issuedAt: new Date().toISOString(),
      entries,
      ...(state.update ? { update: state.update } : {}),
    }),
  );
  const signature = crypto.sign(
    null,
    body,
    crypto.createPrivateKey(fs.readFileSync(VENDOR_KEY)),
  );
  await github(state, 'PATCH', `/gists/${state.gistId}`, {
    files: {
      [STATUS_FILE]: {
        content: `${body.toString('base64url')}.${signature.toString('base64url')}`,
      },
    },
  });
  return { published: true };
}

function vendorView(state) {
  return {
    connected: !!state.gistId,
    statusUrl: state.statusUrl ?? null,
    telegram: {
      connected: !!state.telegram?.chatId,
      bot: state.telegram?.bot ?? null,
    },
    blockedInstalls: Object.keys(state.blockedInstalls ?? {}),
    update: state.update
      ? { version: state.update.version, publishedAt: state.update.publishedAt }
      : null,
    customers: Object.values(state.customers)
      .map((customer) => ({
        installId: customer.installId,
        customer: customer.customer,
        expiresAt: customer.expiresAt,
        blocked: !!customer.blocked,
        features: customer.features ?? [],
        maxBranches: customer.maxBranches ?? null,
        maxUsers: customer.maxUsers ?? null,
        maxDevices: customer.maxDevices ?? null,
        hiddenMenus: customer.hiddenMenus ?? [],
        settings: customer.settings ?? { orders: {} },
        deniedPermissions: customer.deniedPermissions ?? [],
        key: customer.key ?? null,
      }))
      .sort((a, b) => String(a.customer).localeCompare(String(b.customer))),
  };
}

const isVendorComputer = () => fs.existsSync(VENDOR_KEY);
ipcMain.on('vendor:isVendor', (event) => {
  event.returnValue = isVendorComputer();
});
ipcMain.handle('vendor:history', () => vendorHistory());
ipcMain.handle('vendor:state', () => vendorView(vendorState()));

ipcMain.handle('vendor:connect', async (_event, token) => {
  const state = vendorState();
  state.githubToken = String(token || '').trim();
  if (!state.githubToken) throw new Error('GitHub token kiriting');
  if (!state.gistId) {
    const gist = await github(state, 'POST', '/gists', {
      description: 'FastFood licence status (signed)',
      public: false,
      files: { [STATUS_FILE]: { content: 'init' } },
    });
    state.gistId = gist.id;
    state.statusUrl = `https://gist.githubusercontent.com/${gist.owner.login}/${gist.id}/raw/${STATUS_FILE}`;
  }
  saveVendorState(state);
  await publishStatus(state);
  return vendorView(state);
});

/** New customer (or new terms): signs a key and publishes it. */
ipcMain.handle('vendor:sign', async (_event, input) => {
  const state = vendorState();
  const { payload, key } = signLicense(input, state.statusUrl);
  state.customers[payload.installId] = {
    ...(state.customers[payload.installId] ?? { blocked: false }),
    ...payload,
    key,
  };
  saveVendorState(state);
  const result = await publishStatus(state).catch((error) => ({
    published: false,
    error: error.message,
  }));
  return { key, ...result };
});

/** Extends a customer by whole months from the later of today and the current end. */
ipcMain.handle('vendor:extend', async (_event, installId, months) => {
  const state = vendorState();
  const customer = state.customers[installId];
  if (!customer) throw new Error('Mijoz topilmadi');
  const today = new Date().toISOString().slice(0, 10);
  const base = new Date(
    `${customer.expiresAt > today ? customer.expiresAt : today}T00:00:00Z`,
  );
  base.setUTCMonth(base.getUTCMonth() + Number(months || 1));
  const { payload, key } = signLicense(
    { ...customer, expiresAt: base.toISOString().slice(0, 10) },
    state.statusUrl,
  );
  state.customers[installId] = { ...customer, ...payload, key, blocked: false };
  saveVendorState(state);
  const result = await publishStatus(state).catch((error) => ({
    published: false,
    error: error.message,
  }));
  return { key, expiresAt: payload.expiresAt, ...result };
});

/** Changes a customer's features, menus and limits without touching the paid period. */
ipcMain.handle('vendor:update', async (_event, installId, changes) => {
  const state = vendorState();
  const customer = state.customers[installId];
  if (!customer) throw new Error('Mijoz topilmadi');
  const { payload, key } = signLicense(
    {
      ...customer,
      features: changes.features ?? customer.features,
      hiddenMenus: changes.hiddenMenus ?? customer.hiddenMenus,
      settings: changes.settings ?? customer.settings,
      deniedPermissions:
        changes.deniedPermissions ?? customer.deniedPermissions,
      maxBranches:
        changes.maxBranches !== undefined
          ? changes.maxBranches
          : customer.maxBranches,
      maxUsers:
        changes.maxUsers !== undefined ? changes.maxUsers : customer.maxUsers,
      maxDevices:
        changes.maxDevices !== undefined
          ? changes.maxDevices
          : customer.maxDevices,
    },
    state.statusUrl,
  );
  state.customers[installId] = { ...customer, ...payload, key };
  saveVendorState(state);
  const result = await publishStatus(state).catch((error) => ({
    published: false,
    error: error.message,
  }));
  return { key, ...result };
});

const paymentWatch = alerts.createPaymentWatch({
  vendorState,
  saveVendorState,
  log,
});

const reportWatch = reports.createReportWatch({
  vendorDir: VENDOR_DIR,
  vendorState,
  saveVendorState,
  log,
});

/** Every install that reported in (demo and paid), newest first. */
ipcMain.handle('vendor:installs', () => {
  const state = vendorState();
  const installs = Object.values(state.installs ?? {});
  return installs
    .map((item) => ({
      installId: item.installId,
      version: item.version,
      installedAt: item.installedAt,
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
      license: item.license ?? null,
      business: item.business ?? null,
      paid: !!state.customers[item.installId],
      blocked:
        !!state.blockedInstalls?.[item.installId] ||
        !!state.customers[item.installId]?.blocked,
      sameMachine: item.machine
        ? installs
            .filter(
              (other) =>
                other.machine === item.machine &&
                other.installId !== item.installId,
            )
            .map((other) => other.installId)
        : [],
    }))
    .sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
});

ipcMain.handle('vendor:checkReports', () => reportWatch.poll());

/** Blocks or unblocks any install by its ID (e.g. a demo that has no licence). */
ipcMain.handle('vendor:blockInstall', async (_event, installId, blocked) => {
  const id = String(installId || '')
    .trim()
    .toUpperCase();
  if (!/^FF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(id))
    throw new Error('O‘rnatish ID noto‘g‘ri (FF-XXXX-XXXX-XXXX)');
  const state = vendorState();
  if (state.customers[id]) state.customers[id].blocked = !!blocked;
  else {
    state.blockedInstalls ??= {};
    if (blocked) state.blockedInstalls[id] = new Date().toISOString();
    else delete state.blockedInstalls[id];
  }
  saveVendorState(state);
  return publishStatus(state).catch((error) => ({
    published: false,
    error: error.message,
  }));
});

/** Connects the vendor's Telegram bot; the chat is found from the vendor's /start. */
ipcMain.handle('vendor:telegram', async (_event, token) => {
  const state = vendorState();
  if (token && String(token).trim()) {
    state.telegram = { token: String(token).trim() };
    const me = await alerts.telegram(state, 'getMe');
    state.telegram.bot = me.username;
    saveVendorState(state);
  }
  if (!state.telegram?.token) throw new Error('Bot tokenini kiriting');
  const updates = await alerts.telegram(state, 'getUpdates', { timeout: 0 });
  const chat = [...updates]
    .reverse()
    .map((update) => update.message?.chat)
    .find((item) => item && item.type === 'private');
  if (!chat) return { connected: false, bot: state.telegram.bot ?? null };
  state.telegram.chatId = chat.id;
  saveVendorState(state);
  await alerts.telegram(state, 'sendMessage', {
    chat_id: chat.id,
    text: '✅ FastFood sotuvchi paneli ulandi. Mijozlarning to‘lov muddati yaqinlashganda yoki tugaganda shu yerga xabar keladi.',
  });
  void paymentWatch.check();
  return { connected: true, bot: state.telegram.bot ?? null };
});

ipcMain.handle('vendor:telegramOff', () => {
  const state = vendorState();
  delete state.telegram;
  saveVendorState(state);
  return true;
});

ipcMain.handle('vendor:block', async (_event, installId, blocked) => {
  const state = vendorState();
  if (!state.customers[installId]) throw new Error('Mijoz topilmadi');
  state.customers[installId].blocked = !!blocked;
  saveVendorState(state);
  return publishStatus(state);
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

/** The vendor tools live inside the app (left menu: Sotuvchi paneli). */
registerUpdates({
  statusUrl: () => licenseStatusUrl().LICENSE_STATUS_URL ?? null,
  log,
});

const RELEASE_REPO = 'fastfood-yangilanish';

async function uploadAsset(state, release, file, name, contentType) {
  const data = fs.readFileSync(file);
  const url = release.upload_url.replace(/\{.*\}$/, '');
  const response = await fetch(`${url}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': contentType,
      'User-Agent': 'FastFood-Vendor',
    },
    body: data,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) throw new Error(`Fayl yuklanmadi (${response.status})`);
  const asset = await response.json();
  return {
    url: asset.browser_download_url,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
  };
}

/**
 * Publishes a new version to every customer: uploads the installer (and APK) to a
 * public GitHub release, then adds the signed update entry to the status document.
 */
ipcMain.handle('vendor:publishUpdate', async (_event, notes) => {
  const state = vendorState();
  if (!state.githubToken || !state.gistId)
    throw new Error('Avval masofaviy boshqaruvni ulang (GitHub token)');
  const picked = await dialog.showOpenDialog(win, {
    title: 'Yangi versiya o‘rnatuvchisini tanlang (FastFood-Setup-X.Y.Z.exe)',
    properties: ['openFile'],
    filters: [{ name: 'FastFood', extensions: ['exe'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
  const exe = picked.filePaths[0];
  const match = /FastFood-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(exe);
  if (!match)
    throw new Error(
      'Fayl nomi FastFood-Setup-X.Y.Z.exe ko‘rinishida bo‘lishi kerak',
    );
  const version = match[1];
  const apkPath = path.join(path.dirname(exe), `FastFood-${version}.apk`);
  const user = await github(state, 'GET', '/user');
  let repo;
  try {
    repo = await github(state, 'GET', `/repos/${user.login}/${RELEASE_REPO}`);
  } catch {
    try {
      repo = await github(state, 'POST', '/user/repos', {
        name: RELEASE_REPO,
        description: 'FastFood dasturi yangilanishlari',
        private: false,
        auto_init: true,
      });
    } catch {
      throw new Error(
        'GitHub token yangilanish joylashga ruxsat bermadi. Yangi token yarating: “gist” va “public_repo” belgilari yoqilgan bo‘lsin, so‘ng uni shu sahifada qayta ulang.',
      );
    }
  }
  const tag = `v${version}`;
  let release;
  try {
    release = await github(
      state,
      'GET',
      `/repos/${repo.full_name}/releases/tags/${tag}`,
    );
  } catch {
    release = await github(state, 'POST', `/repos/${repo.full_name}/releases`, {
      tag_name: tag,
      name: `FastFood ${version}`,
      body: String(notes || ''),
    });
  }
  const existing = new Map(
    (release.assets ?? []).map((asset) => [asset.name, asset]),
  );
  for (const name of [path.basename(exe), path.basename(apkPath)])
    if (existing.has(name))
      await github(
        state,
        'DELETE',
        `/repos/${repo.full_name}/releases/assets/${existing.get(name).id}`,
      ).catch(() => null);
  const exeAsset = await uploadAsset(
    state,
    release,
    exe,
    path.basename(exe),
    'application/octet-stream',
  );
  const apkAsset = fs.existsSync(apkPath)
    ? await uploadAsset(
        state,
        release,
        apkPath,
        path.basename(apkPath),
        'application/vnd.android.package-archive',
      )
    : null;
  state.update = {
    version,
    notes: String(notes || '').slice(0, 2000),
    publishedAt: new Date().toISOString(),
    exe: exeAsset,
    ...(apkAsset ? { apk: apkAsset } : {}),
  };
  saveVendorState(state);
  await publishStatus(state);
  log(`published update ${version}`);
  return { version, apk: !!apkAsset };
});

function openVendorPanel() {
  if (win) win.loadURL(`http://localhost:${APP_PORT}/sotuvchi`);
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
  if (isVendorComputer()) {
    paymentWatch.start();
    const state = vendorState();
    if (reports.ensureReportKeys(VENDOR_DIR, state)) saveVendorState(state);
    reportWatch.start();
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
