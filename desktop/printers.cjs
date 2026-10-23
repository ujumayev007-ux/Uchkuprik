'use strict';
// Receipt and kitchen printers of the Kassa computer (Windows printers). Shared by the
// Kassa application (admin-desktop) and the Kassa server edition (desktop): each main.cjs
// registers them once with its own window, server address and settings file.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

const MISSING = (name) =>
  name
    ? `«${name}» printeri topilmadi. Printer kompyuterga ulanganini va yoqilganini tekshiring.`
    : 'Asosiy printer yo‘q. Printerni ulang yoki sozlamada printerni tanlang.';
const OFFLINE = (name) =>
  `«${name}» printeri uzilgan (offline). Kabel yoki Wi-Fi ulanishini va printer yoqilganini tekshiring.`;
const FAILED = (reason) =>
  `Printer chop etmadi${reason ? ` (${reason})` : ''}. Printer yoqilgani, qog‘oz borligi va ulanganini tekshiring.`;

/** Windows' own view of its printers (null when it can not be asked). */
function windowsPrinters() {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: 6000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const value = JSON.parse(stdout);
          resolve(Array.isArray(value) ? value : [value]);
        } catch {
          resolve(null);
        }
      },
    ),
  );
}

/**
 * Windows keeps accepting jobs for a printer that is unplugged or switched off (they wait
 * in the queue): ask Windows first, so the cashier gets a clear message instead.
 */
async function ensurePrinterReady(config) {
  if (process.platform !== 'win32') return;
  const printers = await windowsPrinters();
  if (!printers) return;
  const target = config.deviceName
    ? printers.find((p) => p.Name === config.deviceName)
    : printers.find((p) => p.Default === true);
  if (!target) throw new Error(MISSING(config.deviceName));
  // PrinterStatus 7 = offline.
  if (target.WorkOffline === true || target.PrinterStatus === 7)
    throw new Error(OFFLINE(target.Name));
}

/**
 * @param {{ enabled: () => boolean, getWin: () => Electron.BrowserWindow | null,
 *   getUrl: () => string, dataDir: string, settingsFile: string,
 *   saveSettings: (change: object) => void, log: (message: string) => void }} options
 */
module.exports = function registerPrinters({
  enabled,
  getWin,
  getUrl,
  dataDir,
  settingsFile,
  saveSettings,
  log,
}) {
  // ------------------------------------------------ receipt printer of THIS terminal
  // Only the Kassa application, and only pages of its own restaurant server, may use it.
  // The choice lives in this computer's own settings file: other terminals and the
  // restaurant's network (kitchen) printers are never touched.
  const PRINTER_DEFAULT = {
    deviceName: '',
    widthMm: 80,
    copies: 1,
    auto: false,
  };
  const fromServerPage = (event) =>
    enabled() &&
    !!getWin() &&
    event.sender === getWin().webContents &&
    !!getUrl() &&
    String(event.senderFrame?.url || '').startsWith(`${getUrl()}/`);
  const receiptPrinter = () => ({
    ...PRINTER_DEFAULT,
    ...(read(settingsFile).receiptPrinter ?? {}),
  });

  ipcMain.handle('printer:list', async (event) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const printers = await getWin().webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      label: p.displayName || p.name,
      isDefault: p.isDefault === true,
    }));
  });

  ipcMain.handle('printer:get', (event) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    return receiptPrinter();
  });

  ipcMain.handle('printer:set', (event, value) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const next = {
      deviceName: String(value?.deviceName ?? '').slice(0, 200),
      widthMm: value?.widthMm === 58 ? 58 : 80,
      copies: Math.min(5, Math.max(1, Math.trunc(Number(value?.copies) || 1))),
      auto: value?.auto === true,
    };
    saveSettings({ receiptPrinter: next });
    log(
      `receipt printer: ${next.deviceName || '(Windows default)'} ${next.widthMm}mm x${next.copies}`,
    );
    return next;
  });

  /**
   * Opens a print page of this server in a hidden window, waits until `selector` is drawn
   * (anything else — sign-in page, error — is never printed), lets `decide` read the page,
   * and prints it silently on the chosen Windows printer when `decide` says so.
   * `fitHeight`: the paper is cut right after the content (no metres of blank roll).
   */
  async function printServerPage(config, pageUrl, selector, decide, fitHeight) {
    await ensurePrinterReady(config);
    const printWin = new BrowserWindow({
      show: false,
      // A hidden window is throttled by Chromium (slow timers): print without delay.
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    try {
      await printWin.loadURL(pageUrl);
      const drawn = await printWin.webContents.executeJavaScript(
        `new Promise((resolve) => { const start = Date.now(); (function wait() { if (document.querySelector(${JSON.stringify(selector)})) resolve(true); else if (Date.now() - start > 8000) resolve(false); else setTimeout(wait, 100); })(); })`,
      );
      if (!drawn) throw new Error('Chek sahifasi ochilmadi');
      const info = decide
        ? await printWin.webContents.executeJavaScript(decide)
        : { print: true };
      if (!info.print) return info;
      // 96 CSS px per inch; 6 mm of paper after the last line before the cut.
      const heightMm = fitHeight
        ? Math.min(
            2000,
            Math.max(
              40,
              Math.ceil(
                ((await printWin.webContents.executeJavaScript(
                  `Math.ceil(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().bottom)`,
                )) *
                  25.4) /
                  96,
              ) + 6,
            ),
          )
        : 297;
      await new Promise((resolve, reject) =>
        printWin.webContents.print(
          {
            silent: true,
            printBackground: true,
            ...(config.deviceName ? { deviceName: config.deviceName } : {}),
            copies: config.copies,
            margins: { marginType: 'none' },
            pageSize: { width: config.widthMm * 1000, height: heightMm * 1000 },
          },
          (ok, reason) => (ok ? resolve() : reject(new Error(FAILED(reason)))),
        ),
      );
      return info;
    } finally {
      if (!printWin.isDestroyed()) printWin.destroy();
    }
  }

  /** Prints a receipt page of this server silently on the chosen Windows printer. */
  ipcMain.handle('printer:print', async (event, target) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const pagePath = String(target || '');
    if (!/^\/(chek\/[0-9a-f-]{36}|chek-sinov)$/.test(pagePath))
      throw new Error('Noto‘g‘ri sahifa');
    const config = receiptPrinter();
    await printServerPage(
      config,
      `${getUrl()}${pagePath}?silent=1&width=${config.widthMm}`,
      '.receipt',
      null,
      true,
    );
    return { ok: true };
  });

  // ------------------------------------------------ kitchen printer of THIS terminal
  // A Windows printer seen by this Kassa computer (USB, a network printer installed in
  // Windows, or a printer shared by the kitchen computer). New orders and added items are
  // printed once; items removed after printing come out as «BEKOR QILINDI». What was
  // printed is remembered here (kitchen-printed.json), so a restart never reprints.
  const KITCHEN_DEFAULT = {
    deviceName: '',
    widthMm: 80,
    copies: 1,
    auto: false,
    // Orders placed before automatic printing was switched on are not printed.
    enabledAt: '',
  };
  const KITCHEN_STATE = path.join(dataDir, 'kitchen-printed.json');
  const KEEP_MS = 3 * 86_400_000;
  const kitchenPrinter = () => ({
    ...KITCHEN_DEFAULT,
    ...(read(settingsFile).kitchenPrinter ?? {}),
  });

  ipcMain.handle('printer:kitchen-get', (event) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    return kitchenPrinter();
  });

  ipcMain.handle('printer:kitchen-set', (event, value) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const before = kitchenPrinter();
    const auto = value?.auto === true;
    const next = {
      deviceName: String(value?.deviceName ?? '').slice(0, 200),
      widthMm: value?.widthMm === 58 ? 58 : 80,
      copies: Math.min(5, Math.max(1, Math.trunc(Number(value?.copies) || 1))),
      auto,
      enabledAt:
        auto && !(before.auto && before.enabledAt)
          ? new Date().toISOString()
          : auto
            ? before.enabledAt
            : '',
    };
    saveSettings({ kitchenPrinter: next });
    log(
      `kitchen printer: ${next.deviceName || '(Windows default)'} ${next.widthMm}mm x${next.copies} auto=${next.auto}`,
    );
    return next;
  });

  ipcMain.handle('printer:kitchen-test', async (event) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const config = kitchenPrinter();
    await printServerPage(
      config,
      `${getUrl()}/oshxona-chek-sinov?silent=1&width=${config.widthMm}`,
      '.kitchen-ticket',
      null,
      true,
    );
    return { ok: true };
  });

  const readKitchenState = () => {
    const state = read(KITCHEN_STATE);
    return state && typeof state.orders === 'object' && state.orders
      ? state
      : { orders: {} };
  };
  function saveKitchenState(state) {
    const now = Date.now();
    for (const [id, entry] of Object.entries(state.orders))
      if (!entry || now - Number(entry.at || 0) > KEEP_MS)
        delete state.orders[id];
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${KITCHEN_STATE}.tmp`, JSON.stringify(state));
    fs.renameSync(`${KITCHEN_STATE}.tmp`, KITCHEN_STATE);
  }

  /** One order: prints what the kitchen has not seen yet (nothing when all is printed). */
  async function printKitchenOrder(orderId) {
    const config = kitchenPrinter();
    if (!config.auto || !getUrl()) return { printed: false };
    const state = readKitchenState();
    const entry = state.orders[orderId];
    const query = new URLSearchParams({
      silent: '1',
      width: String(config.widthMm),
      printed: (entry?.p ?? []).join(','),
      cancelled: (entry?.c ?? []).join(','),
      ...(entry ? { known: '1' } : {}),
      since: config.enabledAt,
    });
    const info = await printServerPage(
      config,
      `${getUrl()}/oshxona-chek/${orderId}?${query}`,
      '.kitchen-ticket',
      `(() => { const el = document.querySelector('.kitchen-ticket'); return { print: el.dataset.print === '1', fresh: (el.dataset.fresh || '').split(',').filter(Boolean), gone: (el.dataset.gone || '').split(',').filter(Boolean), number: el.dataset.number || '' }; })()`,
      true,
    );
    const latest = readKitchenState();
    const current = latest.orders[orderId] ?? { p: [], c: [] };
    latest.orders[orderId] = {
      p: [...new Set([...current.p, ...info.fresh])],
      c: [...new Set([...current.c, ...info.gone])],
      at: Date.now(),
    };
    saveKitchenState(latest);
    if (info.print)
      log(
        `kitchen ticket ${info.number}: ${info.fresh.length} new, ${info.gone.length} removed`,
      );
    return { printed: info.print, number: info.number };
  }

  // Jobs run one after another (two events for one order never print twice); a failed
  // ticket (printer off, paper out) is tried again every 30 s for 10 minutes.
  let kitchenChain = Promise.resolve();
  const kitchenRetries = new Map();
  function queueKitchen(orderId) {
    const run = kitchenChain.then(() => printKitchenOrder(orderId));
    kitchenChain = run.catch(() => undefined);
    run.then(
      () => kitchenRetries.delete(orderId),
      (error) => {
        const attempt = (kitchenRetries.get(orderId) ?? 0) + 1;
        log(`kitchen ticket failed (${attempt}): ${error?.message ?? error}`);
        if (attempt > 20) {
          kitchenRetries.delete(orderId);
          return;
        }
        kitchenRetries.set(orderId, attempt);
        setTimeout(() => {
          if (kitchenRetries.has(orderId))
            void queueKitchen(orderId).catch(() => undefined);
        }, 30_000);
      },
    );
    return run;
  }

  ipcMain.handle('printer:kitchen-order', async (event, orderId) => {
    if (!fromServerPage(event)) throw new Error('Ruxsat yo‘q');
    const id = String(orderId || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Noto‘g‘ri buyurtma');
    return queueKitchen(id);
  });
};
