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
  try {
    const response = await fetch(`${currentUrl}/api/control/info`, {
      signal: AbortSignal.timeout(6000),
    });
    const info = await response.json();
    if (!response.ok || info.plane !== true) return { ok: false };
  } catch {
    return { ok: false };
  }
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
  // Fail early (and clearly) when the OS cannot protect the device key.
  identity();
  await win.loadURL(`${url}/owner`).catch((error) => {
    if (!onErrorPage) return showConnectionError(error.message);
  });
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
