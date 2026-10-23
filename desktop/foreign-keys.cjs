'use strict';
// Data folder brought from another computer as a plain copy (not a move package): its
// sealed keys (secrets, LAN identity, device key) were encrypted on the old computer with
// that Windows user's application key, which this computer can not read. On the old
// computer the KALIT-OLISH tool writes that key (kochirish-kaliti.txt) into the copied
// folder; here the sealed files are opened with it once and turned into the plain files
// the move package uses, which the normal start then seals with this computer's key.
// Nothing is deleted: the old sealed files are kept as *.enc.eski-<time>.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_FILE = 'kochirish-kaliti.txt';
// Sealed file -> plain file read by the normal start (same names as a move package).
const FILES = [
  ['secrets.enc', 'secrets.json'],
  ['lan-identity.enc', 'lan-identity.json'],
  ['device-key.enc', 'device-key.pem'],
];

/** Chromium "v10" blob: 'v10' | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag. */
function openSealed(blob, key) {
  if (blob.subarray(0, 3).toString('latin1') !== 'v10')
    throw new Error('unknown format');
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(blob.subarray(15, blob.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Runs before the keys are read. Returns false when there is nothing to do. Throws (and
 * changes nothing) when the key does not open the secrets, so no new keys are ever made
 * over the old ones.
 */
function importForeignKeys({ dataDir, safeStorage, log }) {
  const keyFile = path.join(dataDir, KEY_FILE);
  if (!fs.existsSync(keyFile)) return false;
  const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  if (key.length !== 32)
    throw new Error(
      `${keyFile}: kalit noto‘g‘ri (KALIT-OLISH’ni qayta bajaring).`,
    );
  const opened = [];
  for (const [sealedName, plainName] of FILES) {
    const sealed = path.join(dataDir, sealedName);
    if (!fs.existsSync(sealed)) continue;
    const blob = fs.readFileSync(sealed);
    // Already readable here (e.g. sealed again after an earlier import): keep it.
    try {
      safeStorage.decryptString(blob);
      continue;
    } catch {
      /* sealed on the old computer */
    }
    let text;
    try {
      text = openSealed(blob, key);
    } catch {
      throw new Error(
        `${sealedName} eski kompyuter kaliti bilan ham ochilmadi. KALIT-OLISH’ni ma’lumotlar egasi bo‘lgan Windows foydalanuvchisida bajaring.`,
      );
    }
    opened.push({ sealed, plain: path.join(dataDir, plainName), text });
  }
  // Every file opened: only now is anything changed on disk.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const item of opened) {
    if (!fs.existsSync(item.plain))
      fs.writeFileSync(item.plain, item.text, { mode: 0o600 });
    fs.renameSync(item.sealed, `${item.sealed}.eski-${stamp}`);
  }
  fs.rmSync(keyFile, { force: true });
  log(
    `keys from the old computer imported: ${opened.map((i) => path.basename(i.sealed)).join(', ') || 'none needed'}`,
  );
  return true;
}

module.exports = { importForeignKeys, openSealed, KEY_FILE };
