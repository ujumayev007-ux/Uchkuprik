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
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = {
    appSecretKey: crypto.randomBytes(32).toString('base64'),
    dbPassword: crypto.randomBytes(18).toString('base64url'),
  };
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

async function boot() {
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    title: `FastFood ${VERSION}`,
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, sandbox: true },
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
