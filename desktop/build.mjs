// Builds the Windows installer: FastFood-Setup-<version>.exe
// Each version gets its own app id, product name and install folder, so versions
// install side by side; all of them share %APPDATA%\FastFood-Data (the database).
import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const stage = join(here, 'stage');
const require = createRequire(import.meta.url);
const { version } = JSON.parse(
  readFileSync(join(here, 'package.json'), 'utf8'),
);
// BUILD_CHANNEL=test makes an isolated TEST installer: own app id, data folder,
// ports and output folder; it never bakes the production status/report settings.
const TEST = process.env.BUILD_CHANNEL === 'test';
// BUILD_EDITION=cashier: the FastFood Server installer for the Kassa computer (server,
// database and the FastFood terminal window: PIN pad, each person's own panel); without it, the full-panel server ("FastFood Admin").
const CASHIER = process.env.BUILD_EDITION === 'cashier';
if (process.env.BUILD_EDITION && !CASHIER)
  throw new Error('BUILD_EDITION must be cashier (or unset).');
const sh = (command, cwd = root) =>
  execSync(command, { cwd, stdio: 'inherit' });

console.log(`FastFood ${version}: building server and frontend`);
sh('npm run build');

rmSync(stage, { recursive: true, force: true });
const server = join(stage, 'app-server');
const backend = join(server, 'backend');
mkdirSync(backend, { recursive: true });
cpSync(join(root, 'backend', 'dist'), join(backend, 'dist'), {
  recursive: true,
});
cpSync(
  join(root, 'backend', 'prisma', 'migrations'),
  join(backend, 'prisma', 'migrations'),
  {
    recursive: true,
  },
);
const backendPackage = JSON.parse(
  readFileSync(join(root, 'backend', 'package.json'), 'utf8'),
);
writeFileSync(
  join(backend, 'package.json'),
  JSON.stringify(
    {
      name: 'fastfood-server',
      version,
      private: true,
      type: backendPackage.type ?? 'module',
      dependencies: backendPackage.dependencies,
    },
    null,
    2,
  ),
);
sh('npm install --omit=dev --ignore-scripts --no-audit --no-fund', backend);
cpSync(join(root, 'frontend', 'dist'), join(server, 'frontend', 'dist'), {
  recursive: true,
});
// Phones download the matching Android app from this computer.
const apk = join(root, 'android', 'release', `FastFood-${version}.apk`);
if (existsSync(apk)) {
  mkdirSync(join(server, 'frontend', 'dist', 'downloads'), { recursive: true });
  cpSync(apk, join(server, 'frontend', 'dist', 'downloads', 'FastFood.apk'));
} else
  console.warn('APK not found; build it first: node android/build-apk.mjs');

// Remote licence control: customers' apps poll the vendor's signed status document.
const vendorState = join(homedir(), '.fastfood', 'vendor.json');
if (!TEST && existsSync(vendorState)) {
  let state;
  try {
    state = JSON.parse(readFileSync(vendorState, 'utf8').replace(/^﻿/, ''));
  } catch {
    // Building without it would silently drop remote licence control and install reports.
    throw new Error(
      `${vendorState} is damaged (e.g. after a power cut). Restore it before building: the status address and report key are also inside the last installed build (resources/app-server).`,
    );
  }
  const { statusUrl, report } = state;
  if (statusUrl)
    writeFileSync(join(server, 'license-status-url.txt'), statusUrl);
  // Install reports: topic and the vendor's public encryption key (no secrets).
  if (report?.topic && report?.publicKey)
    writeFileSync(
      join(server, 'report.json'),
      JSON.stringify({ topic: report.topic, publicKey: report.publicKey }),
    );
  else
    console.warn('Report key missing: open the vendor app once, then rebuild.');
}

// Central control (SUPER_OWNER): address and PUBLIC key of the central server. The
// signing key and every Owner credential stay on the central server / Owner app.
{
  const file = join(here, 'control.json');
  const url = process.env.CONTROL_URL;
  const publicKey = process.env.CONTROL_PUBLIC_KEY;
  const settings =
    url && publicKey
      ? { url, publicKey }
      : existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : null;
  const urlOk =
    settings?.url?.startsWith('https://') ||
    (TEST &&
      /^http:[/][/](127[.]0[.]0[.]1|localhost):[0-9]+$/.test(
        settings?.url ?? '',
      ));
  if (urlOk && settings.publicKey)
    writeFileSync(
      join(server, 'control.json'),
      JSON.stringify({ url: settings.url, publicKey: settings.publicKey }),
    );
  // Without it the Owner can not link the install and new terminals wait forever:
  // a production installer is refused (ALLOW_NO_CONTROL=1 only for a deliberate offline build).
  else if (!TEST && process.env.ALLOW_NO_CONTROL !== '1')
    throw new Error(
      'Central control not baked in: set CONTROL_URL and CONTROL_PUBLIC_KEY (or desktop/control.json).',
    );
  else
    console.warn(
      'Central control not baked in: set CONTROL_URL and CONTROL_PUBLIC_KEY (or desktop/control.json).',
    );
}

if (CASHIER)
  writeFileSync(
    join(server, 'edition.json'),
    JSON.stringify({ kind: 'cashier' }),
  );

if (TEST)
  writeFileSync(
    join(server, 'channel.json'),
    JSON.stringify({ channel: 'test' }),
  );

// PostgreSQL 17 binaries for Windows (bin, lib, share).
const native = join(
  here,
  'node_modules',
  '@embedded-postgres',
  'windows-x64',
  'native',
);
if (!existsSync(join(native, 'bin', 'postgres.exe')))
  throw new Error('PostgreSQL binaries missing');
cpSync(native, join(stage, 'postgres'), { recursive: true });

const slug = version.replace(/\./g, '-');
// Kassa edition: own app id, name and output folder (never replaces the server edition).
const product = CASHIER ? 'FastFood Kassa' : 'FastFood';
const fileBase = CASHIER ? 'FastFood-Server' : 'FastFood-Admin';
const out = CASHIER
  ? TEST
    ? 'release-server-test'
    : 'release-server'
  : TEST
    ? 'release-test'
    : 'release';
const { build } = require('electron-builder');
await build({
  projectDir: here,
  config: {
    appId: `uz.fastfood.${CASHIER ? 'kassa' : 'desktop'}.${TEST ? 'test.' : ''}v${slug}`,
    productName: `${product} ${TEST ? 'TEST ' : ''}${version}`,
    // A TEST build installs into its own folder so it never overwrites the working app.
    executableName: `${CASHIER ? 'FastFoodKassaServer' : 'FastFood'}${TEST ? 'Test' : ''}`,
    directories: {
      output: join(here, out),
      buildResources: join(here, 'build'),
    },
    files: [
      'main.cjs',
      'preload.cjs',
      'updates.cjs',
      'vendor-alerts.cjs',
      'vendor-ipc.cjs',
      'reports.cjs',
      'safe-json.cjs',
      'lan.cjs',
      'move.cjs',
      'printers.cjs',
      'foreign-keys.cjs',
      'loading.html',
      'package.json',
    ],
    extraResources: [
      { from: join(stage, 'app-server'), to: 'app-server' },
      { from: join(stage, 'postgres'), to: 'postgres' },
    ],
    asar: true,
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      // Customers see the server as their Admin application (it shows the full Admin
      // panel and runs the server silently); app id, folders and profile are unchanged.
      shortcutName: CASHIER
        ? TEST
          ? `FastFood Server TEST ${version}`
          : 'FastFood Server'
        : TEST
          ? `FastFood TEST ${version}`
          : 'FastFood Admin',
      artifactName: TEST
        ? `${CASHIER ? 'FastFood-Server' : 'FastFood'}-TEST-Setup-${version}.exe`
        : `${fileBase}-Setup-${version}.exe`,
      // Uninstalling a version never touches the shared data folder.
      deleteAppDataOnUninstall: false,
    },
  },
});
console.log(
  `Ready: desktop/${out}/${TEST ? `${CASHIER ? 'FastFood-Server' : 'FastFood'}-TEST` : fileBase}-Setup-${version}.exe`,
);
