// Helper for the OWNER of the production system, run on the owner's own computer.
// It reads the owner's own credentials file (written when the Owner account was created):
//   %USERPROFILE%\.fastfood\control-prod\owner-login.txt
// and shows the e-mail and the current 6-digit sign-in code. The password and the
// authenticator key are never printed; the password can be copied to the clipboard
// with `password` (pipe it to `clip`). Nothing is sent anywhere.
//
//   node scripts/owner-prod-code.mjs            live view: e-mail + code (refreshes)
//   node scripts/owner-prod-code.mjs password   writes only the password (for `| clip`)
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file =
  process.env.OWNER_LOGIN_FILE ||
  join(homedir(), '.fastfood', 'control-prod', 'owner-login.txt');
if (!existsSync(file)) {
  console.error(`Fayl topilmadi: ${file}`);
  process.exit(1);
}
const text = readFileSync(file, 'utf8');
const email = /^Email:\s*(.+)$/m.exec(text)?.[1]?.trim();
const password = /^Parol:\s*(.+)$/m.exec(text)?.[1]?.trim();
const secret = /kiritish\)\s*:\s*([A-Za-z2-7]+)/.exec(text)?.[1];
if (!email || !password || !secret) {
  console.error(
    'Fayl formati tanilmadi (Email, Parol, Autentifikator kaliti kerak).',
  );
  process.exit(1);
}
if (process.argv[2] === 'password') {
  process.stdout.write(password);
  process.exit(0);
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const key = (() => {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of secret.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
})();
const otp = (step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
};

console.log('ISHCHI Owner kirish ma’lumotlari');
console.log(`  Elektron pochta : ${email}`);
console.log('  Parol           : (buferga nusxalangan: Ctrl+V)');
console.log('');
let shown = -1;
for (;;) {
  const now = Date.now();
  const step = Math.floor(now / 30000);
  const left = Math.ceil((30000 - (now % 30000)) / 1000);
  if (left >= 12 && step !== shown) {
    shown = step;
    console.log(`  Kod: ${otp(step)}   (${left} soniya qoldi)`);
  } else if (left < 12 && step === shown) {
    console.log('  … yangi kod chiqadi');
    shown = -2;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
