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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const stage = join(here, 'stage');
const require = createRequire(import.meta.url);
const { version } = JSON.parse(
  readFileSync(join(here, 'package.json'), 'utf8'),
);
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
    appId: `uz.fastfood.desktop.v${slug}`,
    productName: `FastFood ${version}`,
    executableName: 'FastFood',
    directories: {
      output: join(here, 'release'),
      buildResources: join(here, 'build'),
    },
    files: ['main.cjs', 'loading.html', 'package.json'],
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
      shortcutName: `FastFood ${version}`,
      artifactName: `FastFood-Setup-${version}.exe`,
      // Uninstalling a version never touches the shared data folder.
      deleteAppDataOnUninstall: false,
    },
  },
});
console.log(`Ready: desktop/release/FastFood-Setup-${version}.exe`);
