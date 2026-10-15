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
  const read = (file) => {
    try {
      return String(JSON.parse(fs.readFileSync(file, 'utf8')).url || '');
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
    process.env.OWNER_ALLOW_HTTP === '1' &&
    /^http:\/\/(localhost|127\.)/.test(url);
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

function menu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Owner',
        submenu: [
          { label: 'Yangilash (F5)', role: 'reload' },
          { label: 'To‘liq ekran', role: 'togglefullscreen' },
          { type: 'separator' },
          { label: 'Chiqish', role: 'quit' },
        ],
      },
    ]),
  );
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
  // Fail early (and clearly) when the OS cannot protect the device key.
  identity();
  await win.loadURL(`${url}/owner`);
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
