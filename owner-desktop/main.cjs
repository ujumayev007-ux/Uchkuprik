// FAST FOOD Owner: the SUPER_OWNER's own desktop application.
//
// It is only a secure shell around the central server's Owner console:
//  - no Owner credentials, signing keys or database credentials are embedded: the
//    build contains the central server's public address and nothing else;
//  - the installation owns an Ed25519 device key, created on first start and stored
//    encrypted with the operating system's user key (safeStorage / Windows DPAPI);
//    the central server only lets an Owner sign in from an approved device;
//  - the window can only show pages of the central server's origin.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A TEST installer (flag baked at build time) keeps its own profile and device key.
try {
  const baked = JSON.parse(
    fs.readFileSync(
      path.join(
        app.isPackaged ? process.resourcesPath : __dirname,
        'owner.json',
      ),
      'utf8',
    ),
  );
  if (baked.test === true)
    app.setPath(
      'userData',
      path.join(app.getPath('appData'), 'FastFood-Owner-Test'),
    );
} catch {
  /* production build or no baked file */
}
const DATA = app.getPath('userData');
const SETTINGS = path.join(DATA, 'owner-settings.json');
const KEY_FILE = path.join(DATA, 'owner-device.enc');
let win = null;

/** Stable JSON with sorted keys (the exact bytes the server verifies). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/** Central server address: user setting first, then the build's baked value. */
function serverUrl() {
  let testBuild = false;
  const read = (file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Only a TEST installer (flag baked at build time) may use a local http address.
      if (parsed.test === true && file.endsWith('owner.json')) testBuild = true;
      return String(parsed.url || '');
    } catch {
      return '';
    }
  };
  const baked = path.join(
    app.isPackaged ? process.resourcesPath : __dirname,
    'owner.json',
  );
  const url = (read(SETTINGS) || read(baked) || process.env.OWNER_URL || '')
    .trim()
    .replace(/[/]+$/, '');
  const local =
    (testBuild || process.env.OWNER_ALLOW_HTTP === '1') &&
    (url.startsWith('http://127.0.0.1:') ||
      url.startsWith('http://localhost:'));
  return url.startsWith('https://') || local ? url : '';
}

/** The device key pair; created once and never stored in plaintext. */
function identity() {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Operatsion tizimning xavfsiz saqlash imkoniyati mavjud emas. Bu dastur kalitni oddiy faylda saqlamaydi.',
    );
  let pem;
  if (fs.existsSync(KEY_FILE))
    pem = safeStorage.decryptString(fs.readFileSync(KEY_FILE));
  else {
    const pair = crypto.generateKeyPairSync('ed25519');
    pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(KEY_FILE, safeStorage.encryptString(pem), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  return { privateKey, publicKey };
}

ipcMain.handle('owner:deviceKey', () => ({
  publicKey: identity().publicKey,
  label: `${os.hostname()} (Owner)`.slice(0, 80),
}));

ipcMain.handle('owner:sign', (_event, value) => {
  if (value === null || typeof value !== 'object')
    throw new Error('Imzolanadigan qiymat noto‘g‘ri');
  return crypto
    .sign(null, Buffer.from(canonicalJson(value)), identity().privateKey)
    .toString('base64url');
});

// ---- "remember on this computer": the Owner's e-mail and authenticator key, kept in the
// operating system's protected storage (DPAPI), so only the password has to be typed.
// The server is unchanged: it still checks password, approved device key AND the code;
// this application simply computes the code for the owner on their own computer.
const REMEMBER_FILE = path.join(DATA, 'owner-remember.enc');
let lastCodeStep = 0;

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text)
    .toUpperCase()
    .replace(/[\s=-]+/g, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return bytes.length >= 10 ? Buffer.from(bytes) : null;
}

function totpAt(secret, step) {
  const key = base32Decode(secret);
  if (!key) throw new Error('Autentifikator kaliti noto‘g‘ri.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
}

function readRemembered() {
  try {
    if (!fs.existsSync(REMEMBER_FILE) || !safeStorage.isEncryptionAvailable())
      return null;
    const parsed = JSON.parse(
      safeStorage.decryptString(fs.readFileSync(REMEMBER_FILE)),
    );
    return typeof parsed.secret === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// Only the Owner console of the configured central server may use these calls.
const fromConsole = (event) => {
  try {
    const frame = String(event.senderFrame?.url || '');
    return (
      win !== null &&
      event.sender === win.webContents &&
      new URL(frame).origin === new URL(serverUrl()).origin
    );
  } catch {
    return false;
  }
};

ipcMain.handle('owner:remember:get', (event) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  const saved = readRemembered();
  return { email: saved?.email ?? '', hasKey: saved !== null };
});

ipcMain.handle('owner:remember:set', (event, value) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Operatsion tizimning xavfsiz saqlash imkoniyati mavjud emas.',
    );
  const email = String(value?.email || '')
    .trim()
    .toLowerCase()
    .slice(0, 200);
  const secret = String(value?.secret || '')
    .replace(/[\s=-]+/g, '')
    .toUpperCase();
  totpAt(secret, 0); // validates the key
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    REMEMBER_FILE,
    safeStorage.encryptString(JSON.stringify({ email, secret })),
    { mode: 0o600 },
  );
  return { ok: true };
});

// ---- trusted computer: remembered with Windows secure storage (DPAPI) ----------------
// The server decides trust (it saw a valid code from this device key); this file only
// lets the sign-in screen skip the code field. It is tied to this Windows user: another
// user or computer can not read it, and without the device key it opens nothing.
const TRUST_FILE = path.join(DATA, 'owner-trust.enc');

function readTrust() {
  try {
    if (!fs.existsSync(TRUST_FILE) || !safeStorage.isEncryptionAvailable())
      return false;
    const parsed = JSON.parse(
      safeStorage.decryptString(fs.readFileSync(TRUST_FILE)),
    );
    return parsed.trusted === true;
  } catch {
    return false;
  }
}

ipcMain.handle('owner:trust:get', (event) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  return { trusted: readTrust() };
});

ipcMain.handle('owner:trust:set', (event, value) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Operatsion tizimning xavfsiz saqlash imkoniyati mavjud emas.',
    );
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    TRUST_FILE,
    safeStorage.encryptString(
      JSON.stringify({
        trusted: true,
        email: String(value?.email || '').slice(0, 200),
        at: new Date().toISOString(),
      }),
    ),
    { mode: 0o600 },
  );
  return { ok: true };
});

ipcMain.handle('owner:trust:clear', (event) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  fs.rmSync(TRUST_FILE, { force: true });
  return { ok: true };
});

ipcMain.handle('owner:remember:clear', (event) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  fs.rmSync(REMEMBER_FILE, { force: true });
  return { ok: true };
});

/** The current code; a code is single-use, so a second request in the same 30 s waits. */
ipcMain.handle('owner:code', async (event) => {
  if (!fromConsole(event)) throw new Error('Ruxsat yo‘q');
  const saved = readRemembered();
  if (!saved) throw new Error('Kalit saqlanmagan.');
  let step = Math.floor(Date.now() / 30000);
  if (step <= lastCodeStep) {
    await new Promise((resolve) =>
      setTimeout(resolve, (lastCodeStep + 1) * 30000 - Date.now() + 300),
    );
    step = Math.floor(Date.now() / 30000);
  }
  // Too close to the end of the window: use the next one so the code is still valid.
  if (30000 - (Date.now() % 30000) < 2500) {
    await new Promise((resolve) =>
      setTimeout(resolve, 30000 - (Date.now() % 30000) + 300),
    );
    step = Math.floor(Date.now() / 30000);
  }
  lastCodeStep = step;
  return { code: totpAt(saved.secret, step) };
});

// Local vendor tools (licence signing on this computer, GitHub status document,
// update publishing) are shared with the customer app and only work when this
// computer holds the vendor's private key.
const VENDOR_KEY = path.join(
  process.env.FASTFOOD_VENDOR_DIR || path.join(os.homedir(), '.fastfood'),
  'vendor-license-private.pem',
);
if (fs.existsSync(VENDOR_KEY)) {
  try {
    require('./vendor-ipc.cjs').registerVendor({
      ipcMain,
      dialog,
      getWindow: () => win,
      log: (message) => {
        try {
          fs.appendFileSync(
            path.join(DATA, 'owner.log'),
            `${new Date().toISOString()} ${message}\n`,
          );
        } catch {
          /* logging must never break the app */
        }
      },
    });
  } catch (error) {
    ipcMain.on('vendor:isVendor', (event) => {
      event.returnValue = false;
    });
    console.error('vendor tools unavailable', error.message);
  }
} else
  ipcMain.on('vendor:isVendor', (event) => {
    event.returnValue = false;
  });

// ---- server address (changed without rebuilding, e.g. after a server migration) ----
let serverWin = null;
const isTestBuild = () => {
  try {
    return (
      JSON.parse(
        fs.readFileSync(
          path.join(
            app.isPackaged ? process.resourcesPath : __dirname,
            'owner.json',
          ),
          'utf8',
        ),
      ).test === true
    );
  } catch {
    return false;
  }
};

function openServerSettings() {
  if (serverWin) {
    serverWin.focus();
    return;
  }
  serverWin = new BrowserWindow({
    ...(win ? { parent: win, modal: true } : {}),
    width: 600,
    height: 440,
    resizable: false,
    title: 'Server manzili',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'server-preload.cjs'),
    },
  });
  serverWin.setMenu(null);
  serverWin.on('closed', () => {
    serverWin = null;
  });
  void serverWin.loadFile(path.join(__dirname, 'server-settings.html'));
}

const fromServerWindow = (event) =>
  serverWin !== null && event.sender === serverWin.webContents;

ipcMain.handle('server:get', (event) => {
  if (!fromServerWindow(event)) throw new Error('Ruxsat yo‘q');
  return { url: serverUrl(), custom: fs.existsSync(SETTINGS) };
});

ipcMain.handle('server:save', async (event, value) => {
  if (!fromServerWindow(event)) throw new Error('Ruxsat yo‘q');
  const url = String(value || '')
    .trim()
    .replace(/[/]+$/, '');
  const local =
    isTestBuild() &&
    /^http:[/][/](127[.]0[.]0[.]1|localhost):[0-9]+$/.test(url);
  if (!url.startsWith('https://') && !local)
    return { ok: false, error: 'Manzil https:// bilan boshlanishi kerak.' };
  try {
    const response = await fetch(`${url}/api/control/info`, {
      signal: AbortSignal.timeout(10_000),
    });
    const info = await response.json();
    if (!response.ok || info.plane !== true)
      return { ok: false, error: 'Bu manzil FastFood markaziy serveri emas.' };
  } catch {
    return {
      ok: false,
      error: 'Manzilga ulanib bo‘lmadi. Internet va manzilni tekshiring.',
    };
  }
  const choice = dialog.showMessageBoxSync(serverWin, {
    type: 'question',
    buttons: ['Saqlash', 'Bekor qilish'],
    defaultId: 1,
    cancelId: 1,
    message: `Markaziy server manzili ${url} ga almashtirilsinmi?`,
    detail:
      'Faqat o‘zingiz ishongan serverga o‘ting: kirish ma’lumotlaringiz shu serverga yuboriladi.',
  });
  if (choice !== 0) return { ok: false, error: 'Bekor qilindi.' };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ url }), { mode: 0o600 });
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 800);
  return { ok: true };
});

ipcMain.handle('server:reset', (event) => {
  if (!fromServerWindow(event)) throw new Error('Ruxsat yo‘q');
  fs.rmSync(SETTINGS, { force: true });
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
  return { ok: true };
});

function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Owner',
        submenu: [
          { label: 'Yangilash (F5)', role: 'reload' },
          { label: 'To‘liq ekran', role: 'togglefullscreen' },
          { label: 'Server manzili…', click: () => openServerSettings() },
          { type: 'separator' },
          { label: 'Chiqish', role: 'quit' },
        ],
      },
    ]),
  );
}

// ---- cannot reach the central server: a clear Uzbek page with retry and settings ----
let currentUrl = '';
let onErrorPage = false;
const ERROR_PAGE = path.join(__dirname, 'connection-error.html');
const SPLASH_PAGE = path.join(__dirname, 'splash.html');

/** True only for our own server's health answer (never a hosting interstitial page). */
async function healthy(url) {
  try {
    const response = await fetch(`${url}/api/health/live`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** Shows the branded splash while the server wakes up, then opens the console. */
async function openConsole(url, waitMs) {
  onErrorPage = false;
  await win.loadFile(SPLASH_PAGE);
  const end = Date.now() + waitMs;
  let ok = await healthy(url);
  while (!ok && Date.now() < end && win && !win.isDestroyed()) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    ok = await healthy(url);
  }
  if (!win || win.isDestroyed()) return;
  if (!ok) return showConnectionError('server javob bermadi');
  await win.loadURL(`${url}/owner`).catch((error) => {
    if (!onErrorPage) return showConnectionError(error.message);
  });
}
const fromErrorPage = (event) => {
  const frameUrl = String(event.senderFrame?.url || '');
  return (
    win !== null &&
    event.sender === win.webContents &&
    frameUrl.startsWith('file:') &&
    frameUrl.includes('connection-error.html')
  );
};

async function showConnectionError(reason) {
  if (!win || win.isDestroyed()) return;
  onErrorPage = true;
  try {
    fs.appendFileSync(
      path.join(DATA, 'owner.log'),
      `${new Date().toISOString()} connection error ${currentUrl}: ${reason}\n`,
    );
  } catch {
    /* logging must never break the app */
  }
  await win.loadFile(ERROR_PAGE, {
    query: { url: currentUrl, reason: String(reason).slice(0, 160) },
  });
}

ipcMain.handle('conn:retry', async (event) => {
  if (!fromErrorPage(event) || !currentUrl) return { ok: false };
  if (!(await healthy(currentUrl))) return { ok: false };
  onErrorPage = false;
  void win
    .loadURL(`${currentUrl}/owner`)
    .catch((error) => showConnectionError(error.message));
  return { ok: true };
});

ipcMain.handle('conn:settings', (event) => {
  if (!fromErrorPage(event)) throw new Error('Ruxsat yo‘q');
  openServerSettings();
  return { ok: true };
});

// ---- stay signed in until the computer restarts ---------------------------------------
// The Owner signs in once (a long-lived session is requested at sign-in). When the
// computer was restarted or shut down since the last run, the session is ended and a
// new sign-in (and code) is required. Closing and reopening this application does not.
const BOOT_FILE = path.join(DATA, 'owner-boot.json');
/** Minute-resolution boot moment (drift of a few minutes is tolerated). */
const bootMoment = () => Math.round((Date.now() - os.uptime() * 1000) / 60000);

function readBoot() {
  try {
    return JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function writeBoot(value) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(BOOT_FILE, JSON.stringify(value));
  } catch {
    /* A failure here only means the next start asks to sign in again. */
  }
}

/** Ends the Owner session on the server (best effort) and forgets the cookie here. */
async function endOwnerSession(url) {
  try {
    await session.defaultSession.fetch(`${url}/api/control/owner/logout`, {
      method: 'POST',
      headers: {
        Origin: new URL(url).origin,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    /* Offline: the cookie is still removed below; the server session expires by itself. */
  }
  await session.defaultSession.clearStorageData({ storages: ['cookies'] });
}

/** A different boot, or a shutdown/log-off was seen last time: sign in again. */
async function applyBootRule(url) {
  const last = readBoot();
  const now = bootMoment();
  const sameBoot = last && !last.ended && Math.abs(now - last.boot) <= 3;
  if (!sameBoot) await endOwnerSession(url);
  writeBoot({ boot: sameBoot ? last.boot : now, ended: false });
}

async function boot() {
  const url = serverUrl();
  if (!url) {
    dialog.showErrorBox(
      'FastFood Owner',
      'Markaziy server manzili sozlanmagan. O‘rnatuvchi to‘g‘ri tayyorlanganini tekshiring.',
    );
    app.quit();
    return;
  }
  const origin = new URL(url).origin;
  currentUrl = url;
  // The Owner console needs no device permissions at all.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) =>
    done(false),
  );
  menu();
  if (url) await applyBootRule(url);
  // Keep the sign-in on disk even if the application is stopped abruptly.
  setInterval(() => {
    void session.defaultSession.cookies.flushStore().catch(() => undefined);
  }, 10_000).unref();
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'FastFood Owner',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // Windows tells the application when the user shuts down, restarts or logs off: the
  // next start asks to sign in again (also when fast start-up keeps the boot moment).
  win.on('session-end', () => {
    const last = readBoot();
    writeBoot({ boot: last ? last.boot : bootMoment(), ended: true });
  });
  // Only the central server's pages may be shown; everything else opens externally.
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (target.startsWith('https://')) void shell.openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://') && new URL(target).origin !== origin)
      void shell.openExternal(target);
    return { action: 'deny' };
  });
  // A failed load (server down, wrong address, no internet) shows a clear page with
  // retry instead of a blank window or a technical error box.
  win.webContents.on(
    'did-fail-load',
    (_event, code, description, _target, isMainFrame) => {
      if (isMainFrame && code !== -3 && !onErrorPage)
        void showConnectionError(`${description} (${code})`);
    },
  );
  // The hosting answers 502/503/504 while the server sleeps, restarts or deploys: that
  // page is never shown; the splash waits for the server and reopens the console.
  let recovering = false;
  win.webContents.on('did-navigate', (_event, target, status) => {
    if (recovering || status < 500 || !currentUrl) return;
    if (!String(target).startsWith(currentUrl)) return;
    recovering = true;
    try {
      fs.appendFileSync(
        path.join(DATA, 'owner.log'),
        `${new Date().toISOString()} server answered HTTP ${status}; waiting for it\n`,
      );
    } catch {
      /* logging must never break the app */
    }
    // Start once that page has finished loading, so no load in progress is aborted.
    win.webContents.once('did-finish-load', () => {
      void openConsole(currentUrl, 180_000).finally(() => {
        recovering = false;
      });
    });
  });
  // Fail early (and clearly) when the OS cannot protect the device key.
  identity();
  // The server may be asleep (a cold start takes up to a minute or two): a branded
  // splash is shown meanwhile and the console opens by itself.
  await openConsole(url, Number(process.env.OWNER_SPLASH_WAIT_MS) || 120_000);
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
      dialog.showErrorBox('FastFood Owner ishga tushmadi', error.message);
      app.quit();
    }),
  );
}
app.on('window-all-closed', () => app.quit());
