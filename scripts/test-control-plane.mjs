// Isolated TEST central server for the TEST Owner / client / Admin installers.
//
//   node scripts/test-control-plane.mjs setup    first time: own database, throw-away keys, test Owner
//   node scripts/test-control-plane.mjs start    start the server (http://127.0.0.1:4100) in the background
//   node scripts/test-control-plane.mjs status   is it running?
//   node scripts/test-control-plane.mjs code     test Owner e-mail, password and the current sign-in code
//   node scripts/test-control-plane.mjs stop     stop the server
//
// Everything secret (keys, test Owner password and authenticator secret) lives in
// %LOCALAPPDATA%\FastFood-TestControl (or TEST_CONTROL_DIR), never in the repository, and
// belongs only to the test database. It is separate from production by construction:
// own database, own signing key, loopback address only. Never copy these values to a
// production server.
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(root, 'backend');
const dir =
  process.env.TEST_CONTROL_DIR ||
  join(
    process.env.LOCALAPPDATA ||
      join(process.env.HOME || '.', '.local', 'share'),
    'FastFood-TestControl',
  );
const PORT = Number(process.env.TEST_CONTROL_PORT || 4100);
const DB_NAME = process.env.TEST_CONTROL_DB || 'fastfood_control_pilot';
const ENV_FILE = join(dir, 'control-test.env');
const OWNER_FILE = join(dir, 'owner-test.json');
const PUBLIC_FILE = join(dir, 'control-test-public.json');
const PID_FILE = join(dir, 'server.pid');
const LOG_FILE = join(dir, 'server.log');
const base = `http://127.0.0.1:${PORT}`;
const require = createRequire(join(backend, 'package.json'));

const parseEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );

async function health() {
  try {
    const response = await fetch(`${base}/api/control/info`, {
      signal: AbortSignal.timeout(3000),
    });
    const info = await response.json();
    return info.plane === true ? info : null;
  } catch {
    return null;
  }
}

function runNode(args, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd: backend,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) =>
      code === 0 ? done(output) : fail(new Error(output.slice(-600))),
    );
  });
}

async function setup() {
  if (existsSync(ENV_FILE)) {
    console.log(`Sinov serveri allaqachon sozlangan: ${dir}`);
    return;
  }
  if (!existsSync(join(backend, 'dist', 'server.js')))
    throw new Error('Avval "npm run build" ni ishga tushiring.');
  mkdirSync(dir, { recursive: true });
  const rootEnv = readFileSync(join(root, '.env'), 'utf8');
  const adminUrl = /^DATABASE_URL=(.+)$/m.exec(rootEnv)?.[1]?.trim();
  if (!adminUrl) throw new Error('.env faylida DATABASE_URL topilmadi.');
  const pg = require('pg');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [DB_NAME],
  );
  if (exists.rowCount === 0)
    await admin.query(
      `CREATE DATABASE ${DB_NAME} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    );
  await admin.end();
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${DB_NAME}`;

  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const privatePem = pair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const env = {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    APP_ORIGIN: base,
    DATABASE_URL: dbUrl.toString(),
    APP_SECRET_KEY: randomBytes(32).toString('base64'),
    SERVE_FRONTEND: 'true',
    CONTROL_PLANE: 'true',
    CONTROL_SIGNING_KEY: Buffer.from(privatePem).toString('base64'),
    CREDENTIAL_RATE_LIMIT: '200',
    LOG_LEVEL: 'warn',
  };
  writeFileSync(
    ENV_FILE,
    `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(PUBLIC_FILE, JSON.stringify({ url: base, publicKey }, null, 2));
  console.log('Baza tayyorlanmoqda…');
  await runNode(
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    env,
  );
  const password = `Test-${randomBytes(9).toString('base64url')}-1`;
  const email = 'owner.test@example.com';
  const out = await runNode(['dist/cli/control-owner.js'], {
    ...env,
    OWNER_EMAIL: email,
    OWNER_NAME: 'Sinov Owner',
    OWNER_PASSWORD: password,
  });
  const secret = /secret=([A-Z2-7]+)/i.exec(out)?.[1];
  if (!secret) throw new Error('Owner yaratilmadi.');
  writeFileSync(
    OWNER_FILE,
    JSON.stringify({ email, password, mfaSecret: secret }),
    { mode: 0o600 },
  );
  console.log(`Tayyor. Maxfiy fayllar: ${dir}`);
}

async function start() {
  if (!existsSync(ENV_FILE))
    throw new Error('Avval "setup" ni ishga tushiring.');
  if (await health()) {
    console.log(`Sinov serveri allaqachon ishlayapti: ${base}`);
    return;
  }
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(
    process.execPath,
    [`--env-file=${ENV_FILE}`, 'dist/server.js'],
    {
      cwd: backend,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    },
  );
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 40; i += 1) {
    if (await health()) {
      console.log(`Sinov serveri ishlayapti: ${base}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server ishga tushmadi. Jurnal: ${LOG_FILE}`);
}

async function stop() {
  if (existsSync(PID_FILE)) {
    try {
      process.kill(Number(readFileSync(PID_FILE, 'utf8')));
    } catch {
      /* already stopped */
    }
    rmSync(PID_FILE, { force: true });
  }
  console.log('Sinov serveri to‘xtatildi.');
}

const b32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

function otpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', b32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0');
}

function ownerFile() {
  if (!existsSync(OWNER_FILE))
    throw new Error('Avval "setup" ni ishga tushiring.');
  return JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
}

function code() {
  const owner = ownerFile();
  const otp = otpAt(owner.mfaSecret, Math.floor(Date.now() / 30000));
  console.log('SINOV Owner (faqat sinov serveri uchun)');
  console.log(`  Email : ${owner.email}`);
  console.log(`  Parol : ${owner.password}`);
  console.log(`  Kod   : ${otp}  (30 soniya amal qiladi, bir marta ishlaydi)`);
}

/** Live view: the code is shown only while at least 12 s are left to type it. */
async function watch() {
  const owner = ownerFile();
  console.log('SINOV Owner (faqat sinov serveri uchun)');
  console.log(`  Email : ${owner.email}`);
  console.log(`  Parol : ${owner.password}  (buferga nusxalandi: Ctrl+V)`);
  console.log('');
  let shown = -1;
  for (;;) {
    const now = Date.now();
    const step = Math.floor(now / 30000);
    const left = Math.ceil((30000 - (now % 30000)) / 1000);
    if (left >= 12 && step !== shown) {
      shown = step;
      console.log(
        `  Kod: ${otpAt(owner.mfaSecret, step)}   (${left} soniya qoldi; kiritib, «Kirish» ni bosing)`,
      );
    } else if (left < 12 && step === shown) {
      console.log('  … vaqt tugayapti, yangi kod chiqadi');
      shown = -2;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const [command] = process.argv.slice(2);
try {
  if (command === 'setup') await setup();
  else if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'code') code();
  else if (command === 'watch') await watch();
  else if (command === 'password') process.stdout.write(ownerFile().password);
  else if (command === 'status') {
    const info = await health();
    console.log(info ? `Ishlayapti: ${base}` : `O‘chiq: ${base}`);
    process.exitCode = info ? 0 : 1;
  } else {
    console.log(
      'Foydalanish: node scripts/test-control-plane.mjs setup | start | status | code | stop',
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
