// In-app updates. The vendor publishes installers to a public GitHub release and puts
// their version, download URL and SHA-256 into the signed status document every
// install already polls. An install only runs an installer whose hash matches the
// vendor-signed document, so a tampered download is never executed.
const { app, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VENDOR_PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoi+PtuCXdUbF1mWLRmj1yOHATIOKWG91OEGLRANYieM=
-----END PUBLIC KEY-----`);

/** 1 when a > b, -1 when a < b, 0 when equal (x.y.z). */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchSignedDocument(url) {
  const response = await fetch(
    `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`,
    {
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const [body, signature] = (await response.text()).trim().split('.');
  if (
    !body ||
    !signature ||
    !crypto.verify(
      null,
      Buffer.from(body, 'base64url'),
      VENDOR_PUBLIC_KEY,
      Buffer.from(signature, 'base64url'),
    )
  )
    throw new Error('Imzo noto‘g‘ri');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

/**
 * @param {{ statusUrl: () => string | null, log: (m: string) => void }} options
 */
function registerUpdates({ statusUrl, log }) {
  let downloading = false;

  async function available() {
    const url = statusUrl();
    if (!url) return null;
    const doc = await fetchSignedDocument(url);
    const update = doc.update;
    if (
      !update ||
      !update.exe ||
      !/^https:\/\//.test(update.exe.url) ||
      !/^[0-9a-f]{64}$/.test(update.exe.sha256) ||
      compareVersions(update.version, app.getVersion()) <= 0
    )
      return null;
    return update;
  }

  ipcMain.handle('updates:check', async () => {
    try {
      const update = await available();
      return {
        current: app.getVersion(),
        update: update
          ? {
              version: update.version,
              notes: update.notes ?? '',
              size: update.exe.size ?? null,
              publishedAt: update.publishedAt ?? null,
            }
          : null,
      };
    } catch (error) {
      log(`update check failed: ${error.message}`);
      return { current: app.getVersion(), update: null, error: error.message };
    }
  });

  ipcMain.handle('updates:install', async () => {
    if (downloading) throw new Error('Yangilanish allaqachon yuklanmoqda');
    downloading = true;
    try {
      const update = await available();
      if (!update) throw new Error('Yangi versiya topilmadi');
      log(`downloading update ${update.version}`);
      const response = await fetch(update.exe.url, {
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!response.ok)
        throw new Error(`Yuklab bo‘lmadi (HTTP ${response.status})`);
      const data = Buffer.from(await response.arrayBuffer());
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (hash !== update.exe.sha256)
        throw new Error(
          'Yuklangan fayl buzilgan (hash mos emas). Qayta urinib ko‘ring.',
        );
      const file = path.join(
        os.tmpdir(),
        `FastFood-Setup-${update.version}.exe`,
      );
      fs.writeFileSync(file, data);
      log(`starting installer ${file}`);
      // The new version installs side by side and uses the same data folder; this
      // version closes first so the database and port are free for it.
      spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 1500);
      return { ok: true, version: update.version };
    } finally {
      downloading = false;
    }
  });
}

module.exports = { registerUpdates, compareVersions };
