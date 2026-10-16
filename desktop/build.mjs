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
  const { statusUrl, report } = JSON.parse(readFileSync(vendorState, 'utf8'));
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
  else
    console.warn(
      'Central control not baked in: set CONTROL_URL and CONTROL_PUBLIC_KEY (or desktop/control.json).',
    );
}

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
const { build } = require('electron-builder');
await build({
  projectDir: here,
  config: {
    appId: `uz.fastfood.desktop.${TEST ? 'test.' : ''}v${slug}`,
    productName: `FastFood ${TEST ? 'TEST ' : ''}${version}`,
    // A TEST build installs into its own folder so it never overwrites the working app.
    executableName: TEST ? 'FastFoodTest' : 'FastFood',
    directories: {
      output: join(here, TEST ? 'release-test' : 'release'),
      buildResources: join(here, 'build'),
    },
    files: [
      'main.cjs',
      'preload.cjs',
      'updates.cjs',
      'vendor-alerts.cjs',
      'vendor-ipc.cjs',
      'reports.cjs',
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
      shortcutName: `FastFood ${TEST ? 'TEST ' : ''}${version}`,
      artifactName: `FastFood-${TEST ? 'TEST-' : ''}Setup-${version}.exe`,
      // Uninstalling a version never touches the shared data folder.
      deleteAppDataOnUninstall: false,
    },
  },
});
console.log(
  `Ready: desktop/${TEST ? 'release-test' : 'release'}/FastFood-${TEST ? 'TEST-' : ''}Setup-${version}.exe`,
);
