// Demo protection and vendor alerts. Nothing here sends customer data anywhere:
// - the first-install date is kept in the local registry so a reinstall (even after
//   deleting the data folder) does not restart the 14-day demo;
// - the vendor's own computer sends the vendor's Telegram bot reminders about the
//   vendor's own customer list (payments ending soon or overdue).
const { Notification } = require('electron');
const { execFileSync } = require('node:child_process');

const DAY = 86_400_000;
const MARKER_KEY = 'HKCU\\Software\\FastFoodSystem';

function regQuery(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /REG_SZ\s+(.+)\s*$/m.exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Earliest install date of this Windows user (stored locally in the registry). */
function firstInstallDate(candidate) {
  const stored = regQuery(MARKER_KEY, 'FirstInstall');
  if (stored && !Number.isNaN(Date.parse(stored)) && stored < candidate)
    return stored;
  if (!stored || stored > candidate)
    try {
      execFileSync(
        'reg',
        [
          'add',
          MARKER_KEY,
          '/v',
          'FirstInstall',
          '/t',
          'REG_SZ',
          '/d',
          candidate,
          '/f',
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {
      /* Registry unavailable: the data folder date still applies. */
    }
  return candidate;
}

async function telegram(state, method, body) {
  const token = state.telegram?.token;
  if (!token) throw new Error('Telegram bot ulanmagan');
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!data.ok)
    throw new Error(
      response.status === 401 || response.status === 404
        ? 'Bot token noto‘g‘ri'
        : data.description || `Telegram xatosi ${response.status}`,
    );
  return data.result;
}

async function notifyVendor(state, title, text, log) {
  try {
    if (Notification.isSupported())
      new Notification({ title, body: text }).show();
  } catch {
    /* Desktop notifications unavailable. */
  }
  if (state.telegram?.token && state.telegram?.chatId)
    await telegram(state, 'sendMessage', {
      chat_id: state.telegram.chatId,
      text: `${title}\n\n${text}`,
      disable_web_page_preview: true,
    }).catch((error) => log(`telegram failed: ${error.message}`));
}

/** Daily payment reminders from the vendor's customer list (vendor computer only). */
function createPaymentWatch({ vendorState, saveVendorState, log }) {
  async function check() {
    try {
      const state = vendorState();
      const today = new Date().toISOString().slice(0, 10);
      state.reminded ??= {};
      const alerts = [];
      for (const customer of Object.values(state.customers ?? {})) {
        if (customer.blocked || !customer.expiresAt) continue;
        const days = Math.ceil(
          (new Date(`${customer.expiresAt}T23:59:59+05:00`).getTime() -
            Date.now()) /
            DAY,
        );
        if (
          days > 5 ||
          days < -7 ||
          state.reminded[customer.installId] === today
        )
          continue;
        state.reminded[customer.installId] = today;
        alerts.push([
          days > 0
            ? `⏳ To‘lov muddati yaqin: ${days} kun qoldi`
            : '⛔ To‘lov muddati tugadi',
          `🏪 ${customer.customer}\n🆔 ${customer.installId}\n📅 ${customer.expiresAt} gacha`,
        ]);
      }
      saveVendorState(state);
      for (const [title, text] of alerts)
        await notifyVendor(state, title, text, log);
      return { alerts: alerts.length };
    } catch (error) {
      log(`payment watch failed: ${error.message}`);
      return { alerts: 0, error: error.message };
    }
  }
  return {
    check,
    start() {
      setTimeout(() => void check(), 30_000).unref();
      setInterval(() => void check(), 60 * 60_000).unref();
    },
  };
}

module.exports = {
  firstInstallDate,
  telegram,
  notifyVendor,
  createPaymentWatch,
};
