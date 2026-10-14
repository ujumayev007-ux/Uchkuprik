// Install reports (disclosed to the customer on sign-up and on the licence page).
//
// A customer install sends a minimal report every few hours: install ID, business
// name, phone, owner name, version, install date and a one-way hash of the machine
// ID (to spot reinstalls that try to restart the demo). No sales data, PC names or
// Windows user names. Reports are encrypted to the vendor's X25519 key and relayed
// through a ntfy.sh topic, so only the vendor's computer can read them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { notifyVendor } = require('./vendor-alerts.cjs');

const NTFY = 'https://ntfy.sh';
const DAY = 86_400_000;

function machineHash() {
  let raw = null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    raw = /REG_SZ\s+(.+)\s*$/m.exec(out)?.[1]?.trim() ?? null;
  } catch {
    /* Not available. */
  }
  return raw
    ? crypto.createHash('sha256').update(`fastfood|${raw}`).digest('hex').slice(0, 16)
    : null;
}

function encrypt(publicKeyB64, data) {
  const vendorKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const eph = crypto.generateKeyPairSync('x25519');
  const key = crypto
    .createHash('sha256')
    .update(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: vendorKey }))
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return [
    'FF1',
    eph.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

function decrypt(privateKeyPem, text) {
  const [head, eph, iv, tag, body] = String(text).trim().split('.');
  if (head !== 'FF1' || !body) return null;
  try {
    const key = crypto
      .createHash('sha256')
      .update(
        crypto.diffieHellman({
          privateKey: crypto.createPrivateKey(privateKeyPem),
          publicKey: crypto.createPublicKey({
            key: Buffer.from(eph, 'base64url'),
            format: 'der',
            type: 'spki',
          }),
        }),
      )
      .digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    return null;
  }
}

/** Creates the vendor's report key pair and topic once; returns true when created. */
function ensureReportKeys(vendorDir, state) {
  const file = path.join(vendorDir, 'report-private.pem');
  if (fs.existsSync(file) && state.report?.publicKey && state.report?.topic)
    return false;
  const pair = crypto.generateKeyPairSync('x25519');
  fs.writeFileSync(file, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  state.report = {
    topic: `ff-${crypto.randomBytes(16).toString('hex')}`,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  return true;
}

// ---------------------------------------------------------------------------
// Customer side.

async function collectReport({ keys, version, dbConfig }) {
  const report = {
    v: 1,
    installId: keys.installId,
    version,
    installedAt: keys.installedAt,
    machine: machineHash(),
    license: null,
    business: null,
  };
  const { Client } = require('pg');
  const db = new Client(dbConfig);
  await db.connect();
  try {
    const lic = (
      await db.query('SELECT key FROM app_license WHERE id = 1')
    ).rows[0];
    if (lic?.key)
      try {
        const payload = JSON.parse(
          Buffer.from(lic.key.split('.')[0], 'base64url').toString('utf8'),
        );
        report.license = { customer: payload.customer, expiresAt: payload.expiresAt };
      } catch {
        /* Unreadable key: reported as no licence. */
      }
    const tenant = (
      await db.query(
        `SELECT t.id, t.name, t."createdAt", p.phone
           FROM tenants t LEFT JOIN tenant_profiles p ON p."tenantId" = t.id
          WHERE t.kind = 'BUSINESS' ORDER BY t."createdAt" LIMIT 1`,
      )
    ).rows[0];
    if (tenant) {
      const owner = (
        await db.query(
          `SELECT "displayName", phone FROM users
            WHERE "tenantId" = $1 AND "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1`,
          [tenant.id],
        )
      ).rows[0];
      report.business = {
        name: String(tenant.name).slice(0, 80),
        phone: tenant.phone || owner?.phone || null,
        owner: owner ? String(owner.displayName).slice(0, 60) : null,
        registeredAt: tenant.createdAt,
      };
    }
  } finally {
    await db.end().catch(() => undefined);
  }
  return report;
}

function startReporting({ configFile, keys, version, dbConfig, log }) {
  if (!fs.existsSync(configFile)) return;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return;
  }
  if (!config.topic || !config.publicKey) return;
  const send = async () => {
    try {
      const report = await collectReport({ keys, version, dbConfig });
      const response = await fetch(`${NTFY}/${config.topic}`, {
        method: 'POST',
        body: encrypt(config.publicKey, report),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) log(`report failed: HTTP ${response.status}`);
    } catch (error) {
      log(`report failed: ${error.message}`);
    }
  };
  setTimeout(send, 60_000).unref();
  setInterval(send, 3 * 60 * 60_000).unref();
}

// ---------------------------------------------------------------------------
// Vendor side.

const day = (value) => (value ? String(value).slice(0, 10) : '—');

function describe(report) {
  const b = report.business;
  return [
    b ? `🏪 ${b.name}` : '🏪 (biznes hali ro‘yxatdan o‘tmagan)',
    b?.owner ? `👤 ${b.owner}` : null,
    b?.phone ? `📞 ${b.phone}` : null,
    `🆔 ${report.installId} · v${report.version}`,
    `📅 O‘rnatilgan: ${day(report.installedAt)}`,
    report.license
      ? `🔑 Litsenziya: ${report.license.customer}, ${report.license.expiresAt} gacha`
      : '🔑 Demo (litsenziyasiz)',
  ]
    .filter(Boolean)
    .join('\n');
}

function createReportWatch({ vendorDir, vendorState, saveVendorState, log }) {
  const keyFile = path.join(vendorDir, 'report-private.pem');
  let running = false;

  async function poll() {
    if (running || !fs.existsSync(keyFile)) return { checked: false };
    running = true;
    try {
      const state = vendorState();
      if (!state.report?.topic) return { checked: false };
      const privateKey = fs.readFileSync(keyFile, 'utf8');
      const response = await fetch(
        `${NTFY}/${state.report.topic}/json?poll=1&since=${encodeURIComponent(state.reportSince || '12h')}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok) throw new Error(`ntfy ${response.status}`);
      const lines = (await response.text()).split('\n').filter(Boolean);
      state.installs ??= {};
      state.reminded ??= {};
      const alerts = [];
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event !== 'message') continue;
        state.reportSince = event.id;
        const report = decrypt(privateKey, event.message);
        if (
          !report ||
          report.v !== 1 ||
          !/^FF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(report.installId || '')
        )
          continue;
        const previous = state.installs[report.installId];
        const seenAt = new Date((event.time ?? Date.now() / 1000) * 1000).toISOString();
        const others = report.machine
          ? Object.values(state.installs).filter(
              (item) =>
                item.machine === report.machine && item.installId !== report.installId,
            )
          : [];
        state.installs[report.installId] = {
          ...report,
          firstSeen: previous?.firstSeen ?? seenAt,
          lastSeen: seenAt,
        };
        const paid = !!state.customers?.[report.installId];
        if (!previous)
          alerts.push([
            paid ? '🔄 Mijoz dasturi ulandi' : '🆕 Yangi demo o‘rnatildi',
            describe(report) +
              (others.length
                ? `\n\n⚠ Bu kompyuterda avval ham o‘rnatilgan: ${others.map((item) => item.installId).join(', ')}`
                : ''),
          ]);
        else if (!previous.business && report.business)
          alerts.push(['📝 Ro‘yxatdan o‘tdi', describe(report)]);
      }
      // Demo periods ending (14 days from installation), once a day.
      const today = new Date().toISOString().slice(0, 10);
      for (const install of Object.values(state.installs)) {
        if (state.customers?.[install.installId] || install.license) continue;
        if (state.blockedInstalls?.[install.installId]) continue;
        const left = Math.ceil(
          (Date.parse(install.installedAt) + 14 * DAY - Date.now()) / DAY,
        );
        const key = `demo:${install.installId}`;
        if (left > 2 || left < -3 || state.reminded[key] === today) continue;
        state.reminded[key] = today;
        alerts.push([
          left > 0 ? `⌛ Demo tugashiga ${left} kun qoldi` : '⌛ Demo muddati tugadi',
          describe(install),
        ]);
      }
      saveVendorState(state);
      for (const [title, text] of alerts) await notifyVendor(state, title, text, log);
      return { checked: true, alerts: alerts.length };
    } catch (error) {
      log(`report watch failed: ${error.message}`);
      return { checked: false, error: error.message };
    } finally {
      running = false;
    }
  }

  return {
    poll,
    start() {
      setTimeout(() => void poll(), 30_000).unref();
      setInterval(() => void poll(), 5 * 60_000).unref();
    },
  };
}

module.exports = { ensureReportKeys, startReporting, createReportWatch };
