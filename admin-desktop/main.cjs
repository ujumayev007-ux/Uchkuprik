// FAST FOOD Restaurant Admin: the restaurant administrator's own desktop application.
//
// A thin, secure shell around the restaurant's FastFood server (the cashier computer on
// the local network, or a hosted address). It stores no restaurant data and no
// credentials: the administrator signs in with their own account and the SERVER decides
// what that account may do (Owner-granted modules, roles, permissions).
//  - the server address is set on first start and can be changed later without
//    rebuilding the application (menu "Server manzili…");
//  - plain http is accepted only for local network addresses; everything else must be
//    https;
//  - the window can only show pages of that server; other links open in the browser.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const baked = read(
  path.join(app.isPackaged ? process.resourcesPath : __dirname, 'admin.json'),
);
const TEST = baked.test === true;
// A TEST installer keeps its own profile and default port.
if (TEST)
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), 'FastFood-Admin-Test'),
  );
const DATA = app.getPath('userData');
const SETTINGS = path.join(DATA, 'admin-settings.json');
const DEFAULT_PORT = TEST ? 8788 : 8787;
let win = null;
let currentUrl = '';

const log = (message) => {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(
      path.join(DATA, 'admin.log'),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    /* logging must never break the app */
  }
};

/** Local-network or loopback host: the only place plain http is allowed. */
function isLocalHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  if (!host.includes('.')) return true; // a computer name on the local network
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** "192.168.1.11", "kassa:8787" or a full address → a safe origin, or null. */
function normalize(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol !== 'http:' || !isLocalHost(url.hostname)) return null;
  return url.port
    ? url.origin
    : `${url.origin.replace(/\/$/, '')}:${DEFAULT_PORT}`;
}

function serverUrl() {
  return (
    normalize(read(SETTINGS).url) ||
    normalize(baked.url) ||
    normalize(process.env.ADMIN_URL) ||
    ''
  );
}

async function reachable(url) {
  try {
    const response = await fetch(`${url}/api/health/live`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return false;
    // Our own server's answer only (never a hosting interstitial page).
    const body = await response.json();
    return body.status === 'ok';
  } catch {
    return false;
  }
}

const connectPage = (mode, extra = {}) =>
  win.loadFile(path.join(__dirname, 'connect.html'), {
    query: { mode, url: currentUrl, ...extra },
  });

const fromConnectPage = (event) => {
  const frameUrl = String(event.senderFrame?.url || '');
  return (
    win !== null &&
    event.sender === win.webContents &&
    frameUrl.startsWith('file:') &&
    frameUrl.includes('connect.html')
  );
};

async function showError(reason) {
  if (!win || win.isDestroyed()) return;
  log(`connection error ${currentUrl}: ${reason}`);
  await connectPage('error', { reason: String(reason).slice(0, 160) });
}

ipcMain.handle('admin:state', (event) => {
  if (!fromConnectPage(event)) throw new Error('Ruxsat yo‘q');
  return {
    url: currentUrl,
    custom: fs.existsSync(SETTINGS),
    defaultPort: DEFAULT_PORT,
  };
});

ipcMain.handle('admin:retry', async (event) => {
  if (!fromConnectPage(event) || !currentUrl) return { ok: false };
  if (!(await reachable(currentUrl))) return { ok: false };
  void win.loadURL(`${currentUrl}/`).catch((error) => showError(error.message));
  return { ok: true };
});

ipcMain.handle('admin:save', async (event, value) => {
  if (!fromConnectPage(event)) throw new Error('Ruxsat yo‘q');
  const url = normalize(value);
  if (!url)
    return {
      ok: false,
      error:
        'Manzil noto‘g‘ri. Masalan: 192.168.1.11 yoki https://restoran.misol.uz (http faqat mahalliy tarmoq uchun).',
    };
  if (!(await reachable(url)))
    return {
      ok: false,
      error:
        'Bu manzilga ulanib bo‘lmadi. Kassa kompyuteri yoqilganini va bir xil Wi‑Fi’da ekaningizni tekshiring.',
    };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ url }), { mode: 0o600 });
  currentUrl = url;
  log(`server address set to ${url}`);
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 600);
  return { ok: true };
});

ipcMain.handle('admin:reset', (event) => {
  if (!fromConnectPage(event)) throw new Error('Ruxsat yo‘q');
  fs.rmSync(SETTINGS, { force: true });
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 400);
  return { ok: true };
});

function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Admin',
        submenu: [
          { label: 'Yangilash (F5)', role: 'reload' },
          { label: 'To‘liq ekran', role: 'togglefullscreen' },
          {
            label: 'Server manzili…',
            click: () => {
              if (win) void connectPage('setup');
            },
          },
          { type: 'separator' },
          { label: 'Chiqish', role: 'quit' },
        ],
      },
    ]),
  );
}

async function boot() {
  currentUrl = serverUrl();
  // Printing and notifications are the only device features a restaurant page may use.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) =>
    done(permission === 'notifications'),
  );
  menu();
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    title: 'FastFood Admin',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('file:')) return;
    const origin = currentUrl ? new URL(currentUrl).origin : '';
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (target.startsWith('https://')) void shell.openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const origin = currentUrl ? new URL(currentUrl).origin : '';
    if (target.startsWith('https://') && new URL(target).origin !== origin)
      void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on(
    'did-fail-load',
    (_event, code, description, target, isMainFrame) => {
      if (isMainFrame && code !== -3 && !String(target).startsWith('file:'))
        void showError(`${description} (${code})`);
    },
  );
  if (!currentUrl) {
    await connectPage('setup');
    return;
  }
  // The server may still be waking up: a branded splash is shown and the application
  // opens by itself once the server answers.
  await win.loadFile(path.join(__dirname, 'splash.html'));
  const end =
    Date.now() + (Number(process.env.ADMIN_SPLASH_WAIT_MS) || 120_000);
  let ok = await reachable(currentUrl);
  while (!ok && Date.now() < end && !win.isDestroyed()) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    ok = await reachable(currentUrl);
  }
  if (win.isDestroyed()) return;
  if (!ok) return showError('server javob bermadi');
  await win
    .loadURL(`${currentUrl}/`)
    .catch((error) => showError(error.message));
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
      dialog.showErrorBox('FastFood Admin ishga tushmadi', error.message);
      app.quit();
    }),
  );
}
app.on('window-all-closed', () => app.quit());
