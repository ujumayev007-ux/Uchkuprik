// FAST FOOD restaurant applications (Admin, Cashier, Waiter): one secure shell, three
// installers. This is the restaurant administrator's / cashier's / waiter's own desktop application.
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
  WebContentsView,
  screen,
  dialog,
  ipcMain,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const lan = require('./lan.cjs');

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
// One shell, four applications: Admin, Cashier (Kassa), Waiter (Ofitsiant) and Kitchen (Oshxona). Each is
// its own installer with its own name, profile and start page; all of them only show
// the restaurant server's pages after sign-in (nothing is stored here).
const KINDS = {
  admin: {
    label: 'FastFood Admin',
    menu: 'Admin',
    start: '/',
    profile: 'Admin',
  },
  cashier: {
    label: 'FastFood Kassa',
    menu: 'Kassa',
    start: '/kassa',
    profile: 'Kassa',
  },
  waiter: {
    label: 'FastFood Ofitsiant',
    menu: 'Ofitsiant',
    start: '/ofitsiant',
    profile: 'Ofitsiant',
  },
  kitchen: {
    label: 'FastFood Oshxona',
    menu: 'Oshxona',
    start: '/oshxona',
    profile: 'Oshxona',
  },
  tv: {
    label: 'FastFood TV',
    menu: 'TV',
    start: '/navbat',
    profile: 'TV',
  },
};
const KIND = KINDS[baked.kind] ? baked.kind : 'admin';
const APP = KINDS[KIND];
// A TEST installer keeps its own profile and default port.
if (TEST)
  app.setPath(
    'userData',
    path.join(app.getPath('appData'), `FastFood-${APP.profile}-Test`),
  );
const DATA = app.getPath('userData');
const SETTINGS = path.join(DATA, 'admin-settings.json');
const DEFAULT_PORT = TEST ? 8788 : 8787;
const LAN_PORT =
  Number(process.env.FASTFOOD_LAN_PORT) ||
  (TEST ? lan.TEST_DISCOVERY_PORT : lan.DISCOVERY_PORT);
let win = null;
let currentUrl = '';
// "connected" | "connecting" | "offline" — shown as "Ulandi" / "Ulanmoqda" / "Aloqa yo‘q".
let state = 'connecting';
let pill = null;
let lastFound = new Map();

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

async function reachable(url, timeoutMs = 6000) {
  try {
    const response = await fetch(`${url}/api/health/live`, {
      signal: AbortSignal.timeout(timeoutMs),
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
    query: { mode, url: currentUrl, app: APP.label, ...extra },
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

// ------------------------------------------------ automatic connection (LAN)

const STATE_TEXT = {
  connected: 'Ulandi',
  connecting: 'Ulanmoqda',
  offline: 'Aloqa yo‘q',
};

/** The pairing: which server (by its public key) this application belongs to. */
const pairing = () => {
  const { serverId, serverKey } = read(SETTINGS);
  return serverId && serverKey ? { id: serverId, key: serverKey } : null;
};

function saveSettings(change) {
  fs.mkdirSync(DATA, { recursive: true });
  const next = { ...read(SETTINGS), ...change };
  fs.writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(`${SETTINGS}.tmp`, SETTINGS);
}

const onLocalFile = () => !!win && win.webContents.getURL().startsWith('file:');

function layoutPill() {
  if (!win || win.isDestroyed() || !pill) return;
  const { width, height } = win.getContentBounds();
  const w = Math.min(360, width - 20);
  pill.setBounds({
    x: Math.round((width - w) / 2),
    y: height - 52,
    width: w,
    height: 40,
  });
}

function paint() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(`${APP.label} — ${STATE_TEXT[state]}`);
  menu();
  if (pill) {
    // A local page (setup / error) already explains the situation.
    pill.setVisible(state !== 'connected' && !onLocalFile());
    layoutPill();
    pill.webContents.send('lan:state', { state, text: STATE_TEXT[state] });
  }
}

function setState(next) {
  if (state === next) return;
  state = next;
  log(`connection ${next}`);
  paint();
}

/** Remembers `server` (a discovery answer) as this application's server. */
function useServer(server) {
  if (!isLocalHost(server.host)) return false;
  const url = `http://${server.host}:${server.port}`;
  saveSettings({ url, serverId: server.id, serverKey: server.key });
  currentUrl = url;
  log(`server ${server.fingerprint} at ${url} (${server.name})`);
  return true;
}

/** Makes `server` (a discovery answer) this application's server and opens it. */
async function adopt(server) {
  const before = currentUrl;
  if (!useServer(server)) return false;
  const changed = currentUrl !== before;
  if (changed || onLocalFile())
    await win
      .loadURL(`${currentUrl}${APP.start}`)
      .catch((error) => showError(error.message));
  setState('connected');
  return true;
}

/**
 * "Avtomatik ulanish": one server → connect; several → the person chooses; none → a
 * clear message. A paired application only accepts its own (signed) server again.
 */
async function autoConnect() {
  setState('connecting');
  const paired = pairing();
  let found = await lan.discover({
    port: LAN_PORT,
    pinned: paired?.key ?? null,
  });
  if (!found.length && paired) found = await lan.discover({ port: LAN_PORT });
  lastFound = new Map(found.map((server) => [server.id, server]));
  // A paired application never silently switches to a different server.
  if (found.length === 1 && (!paired || found[0].key === paired.key)) {
    await adopt(found[0]);
    return { ok: true, name: found[0].name, code: found[0].fingerprint };
  }
  setState(
    currentUrl && (await reachable(currentUrl, 3000)) ? 'connected' : 'offline',
  );
  return {
    ok: false,
    found: found.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      code: s.fingerprint,
      local: s.local,
    })),
  };
}

let watching = false;
let bootDone = false;
let failures = 0;
/** Every few seconds: is the server there? If its address changed, find it again. */
async function watch() {
  if (!bootDone || watching || !win || win.isDestroyed() || !currentUrl) return;
  watching = true;
  try {
    if (await reachable(currentUrl, 3000)) {
      failures = 0;
      const wasDown = state !== 'connected';
      setState('connected');
      // The error page appeared while the server was away: open the application again.
      if (
        wasDown &&
        onLocalFile() &&
        win.webContents.getURL().includes('mode=error')
      )
        await win.loadURL(`${currentUrl}${APP.start}`).catch(() => {});
      return;
    }
    failures += 1;
    if (failures < 2) return;
    setState('offline');
    const paired = pairing();
    if (!paired) return;
    const found = await lan.discover({
      port: LAN_PORT,
      pinned: paired.key,
      timeoutMs: 2000,
    });
    if (found[0]) await adopt(found[0]);
  } finally {
    watching = false;
  }
}

ipcMain.on('shell:kind', (event) => {
  event.returnValue = KIND;
});

ipcMain.handle('admin:auto', async (event) => {
  if (!fromConnectPage(event)) throw new Error('Ruxsat yo‘q');
  return autoConnect();
});

ipcMain.handle('admin:pick', async (event, id) => {
  if (!fromConnectPage(event)) throw new Error('Ruxsat yo‘q');
  const server = lastFound.get(String(id));
  if (!server) return { ok: false };
  return { ok: await adopt(server) };
});

ipcMain.handle('lan:open', (event) => {
  if (!pill || event.sender !== pill.webContents)
    throw new Error('Ruxsat yo‘q');
  void connectPage('setup', { auto: '1' });
});

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
  void win
    .loadURL(`${currentUrl}${APP.start}`)
    .catch((error) => showError(error.message));
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

// ---- TV application: the customer queue fullscreen on a chosen (HDMI) display ----------
// The operator keeps the main monitor; the window never takes the keyboard focus.
function tvDisplay() {
  const all = screen.getAllDisplays();
  const saved = read(SETTINGS).tvDisplay;
  return (
    all.find((display) => String(display.id) === String(saved)) ??
    all.find((display) => display.id !== screen.getPrimaryDisplay().id) ??
    screen.getPrimaryDisplay()
  );
}

function placeTv() {
  if (KIND !== 'tv' || !win || win.isDestroyed()) return;
  const display = tvDisplay();
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setBounds(display.bounds);
  win.setFullScreen(true);
  if (!win.isVisible()) win.showInactive();
}

function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP.menu,
        submenu: [
          { label: 'Yangilash (F5)', role: 'reload' },
          { label: 'To‘liq ekran', role: 'togglefullscreen' },
          {
            label: 'Avtomatik ulanish',
            click: () => {
              if (win) void connectPage('setup', { auto: '1' });
            },
          },
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
      ...(KIND === 'tv'
        ? [
            {
              label: 'Ekran',
              submenu: screen.getAllDisplays().map((display, index) => ({
                label: `${index + 1}-ekran: ${display.size.width}×${display.size.height}${display.id === screen.getPrimaryDisplay().id ? ' (asosiy)' : ''}`,
                type: 'radio',
                checked: display.id === tvDisplay().id,
                click: () => {
                  saveSettings({ tvDisplay: display.id });
                  placeTv();
                  menu();
                },
              })),
            },
          ]
        : []),
      {
        label: `${state === 'connected' ? '●' : state === 'connecting' ? '◌' : '○'} ${STATE_TEXT[state]}`,
        submenu: [
          { label: `Holat: ${STATE_TEXT[state]}`, enabled: false },
          {
            label: 'Avtomatik ulanish',
            click: () => {
              if (win) void connectPage('setup', { auto: '1' });
            },
          },
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
  // Report files (Excel, Word, PDF) go straight to the Downloads folder and are shown
  // there; no hidden save dialog, and a file never overwrites an earlier one.
  session.defaultSession.on('will-download', (_event, item) => {
    const dir = app.getPath('downloads');
    const name = path
      .basename(item.getFilename())
      .replace(/[<>:"/\\|?*]/g, '_');
    const ext = path.extname(name);
    let target = path.join(dir, name);
    for (let i = 2; fs.existsSync(target); i++)
      target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
    item.setSavePath(target);
    item.once('done', (_done, state) => {
      if (state === 'completed' && process.env.ADMIN_NO_REVEAL !== '1')
        shell.showItemInFolder(target);
    });
  });
  menu();
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    title: APP.label,
    ...(KIND === 'tv'
      ? { show: false, autoHideMenuBar: true, backgroundColor: '#000000' }
      : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // The TV announces ready orders without anyone tapping the screen.
      ...(KIND === 'tv' ? { autoplayPolicy: 'no-user-gesture-required' } : {}),
    },
  });
  if (KIND === 'tv') {
    placeTv();
    // A cable plugged in or out, or a changed resolution: place the window again.
    for (const event of [
      'display-added',
      'display-removed',
      'display-metrics-changed',
    ])
      screen.on(event, () => {
        placeTv();
        menu();
      });
  }
  // The title shows the connection status ("Ulandi" / "Ulanmoqda" / "Aloqa yo‘q").
  win.on('page-title-updated', (event) => event.preventDefault());
  pill = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'status-preload.cjs'),
    },
  });
  win.contentView.addChildView(pill);
  void pill.webContents.loadFile(path.join(__dirname, 'status.html'));
  win.on('resize', layoutPill);
  win.webContents.on('did-navigate', paint);
  win.webContents.on('did-finish-load', paint);
  paint();
  setInterval(() => void watch(), 5000).unref();
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
    // First start: look for the restaurant server by itself.
    bootDone = true;
    await connectPage('setup', { auto: '1' });
    return;
  }
  // The server may still be waking up: a branded splash is shown and the application
  // opens by itself once the server answers.
  await win.loadFile(path.join(__dirname, 'splash.html'));
  const end =
    Date.now() + (Number(process.env.ADMIN_SPLASH_WAIT_MS) || 120_000);
  let ok = await reachable(currentUrl, 4000);
  while (!ok && Date.now() < end && !win.isDestroyed()) {
    // Paired with a server whose address changed (new router, new Wi-Fi): find it again.
    const paired = pairing();
    if (paired) {
      const [server] = await lan.discover({
        port: LAN_PORT,
        pinned: paired.key,
        timeoutMs: 2000,
      });
      if (server && useServer(server)) {
        ok = await reachable(currentUrl, 4000);
        if (ok) break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    ok = await reachable(currentUrl, 4000);
  }
  if (win.isDestroyed()) return;
  bootDone = true;
  if (!ok) {
    setState('offline');
    return showError('server javob bermadi');
  }
  setState('connected');
  await win
    .loadURL(`${currentUrl}${APP.start}`)
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
      dialog.showErrorBox(`${APP.label} ishga tushmadi`, error.message);
      app.quit();
    }),
  );
}
app.on('window-all-closed', () => app.quit());
