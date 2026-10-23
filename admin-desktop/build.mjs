// Builds the Restaurant Admin installer: FastFood-Admin-Setup-<version>.exe
// Only PUBLIC data can be baked in: an optional default server address (ADMIN_URL).
// Without it the application asks for the restaurant server address on first start,
// and the address can be changed later without rebuilding.
// BUILD_CHANNEL=test: isolated TEST installer (own app id, profile, default port 8788).
// Code signing: set CSC_LINK / CSC_KEY_PASSWORD (a .pfx); unsigned builds are for
// internal testing only.
import {
  copyFileSync,
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
// Reuse the Owner application's installed electron / electron-builder when this folder
// has no node_modules of its own (same versions, see both package.json files).
const require = createRequire(
  existsSync(join(here, 'node_modules'))
    ? import.meta.url
    : join(here, '..', 'owner-desktop', 'package.json'),
);
const { version } = JSON.parse(
  readFileSync(join(here, 'package.json'), 'utf8'),
);
const TEST = process.env.BUILD_CHANNEL === 'test';
// PANEL_KIND chooses the application: admin (default), cashier, waiter or kitchen.
const KINDS = {
  admin: {
    product: 'FastFood Admin',
    exe: 'FastFoodAdmin',
    id: 'admin',
    file: 'FastFood-Admin',
  },
  cashier: {
    product: 'FastFood Kassa',
    exe: 'FastFoodKassa',
    id: 'cashier',
    file: 'FastFood-Kassa',
  },
  waiter: {
    product: 'FastFood Ofitsiant',
    exe: 'FastFoodOfitsiant',
    id: 'waiter',
    file: 'FastFood-Ofitsiant',
  },
  kitchen: {
    product: 'FastFood Oshxona',
    exe: 'FastFoodOshxona',
    id: 'kitchen',
    file: 'FastFood-Oshxona',
  },
  tv: {
    product: 'FastFood TV',
    exe: 'FastFoodTV',
    id: 'tv',
    file: 'FastFood-TV',
  },
};
const kind = process.env.PANEL_KIND || 'admin';
if (!KINDS[kind])
  throw new Error('PANEL_KIND must be admin, cashier, waiter, kitchen or tv.');
const APP = KINDS[kind];
const url = (process.env.ADMIN_URL || '').trim().replace(/[/]+$/, '');
if (url && !/^https:[/][/]/.test(url) && !TEST)
  throw new Error('ADMIN_URL must be an https address (or leave it empty).');

const stage = join(here, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const baked = JSON.stringify({
  kind,
  ...(url ? { url } : {}),
  ...(TEST ? { test: true } : {}),
});
writeFileSync(join(stage, 'admin.json'), baked);
for (const name of [
  'main.cjs',
  'preload.cjs',
  'status-preload.cjs',
  'connect.html',
  'status.html',
  'splash.html',
])
  copyFileSync(join(here, name), join(stage, name));
// Automatic connection (LAN discovery) is shared with the server application.
copyFileSync(join(here, '..', 'desktop', 'lan.cjs'), join(stage, 'lan.cjs'));
// So are the Kassa receipt and kitchen printers.
copyFileSync(
  join(here, '..', 'desktop', 'printers.cjs'),
  join(stage, 'printers.cjs'),
);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: `fastfood-${kind}`,
    productName: APP.product,
    version,
    main: 'main.cjs',
    author: 'FAST FOOD',
  }),
);
// A production build carries no test flag and no credentials of any kind.
if (!TEST && /"test"/.test(baked))
  throw new Error('A production Admin build must not contain test settings.');
for (const name of ['main.cjs', 'preload.cjs', 'connect.html'])
  if (
    /owner\.test@|mfaSecret|Test-[A-Za-z0-9_-]{8,}-1/.test(
      readFileSync(join(stage, name), 'utf8'),
    )
  )
    throw new Error(`Test credentials found in ${name}; build refused.`);

const { build } = require('electron-builder');
const out =
  process.env.ADMIN_BUILD_OUT || join(here, TEST ? 'release-test' : 'release');
const artifact = `${APP.file}${TEST ? '-TEST' : ''}-Setup-${version}.exe`;
await build({
  projectDir: stage,
  config: {
    appId: `uz.fastfood.${APP.id}${TEST ? '.test' : ''}`,
    productName: TEST ? `${APP.product} TEST` : APP.product,
    executableName: `${APP.exe}${TEST ? 'Test' : ''}`,
    electronVersion: require('electron/package.json').version,
    directories: { output: out },
    files: ['**/*', '!admin.json'],
    extraResources: [{ from: join(stage, 'admin.json'), to: 'admin.json' }],
    asar: true,
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      artifactName: artifact,
      deleteAppDataOnUninstall: false,
    },
  },
});
if (!existsSync(join(out, artifact)))
  throw new Error('Admin installer was not produced.');
console.log(
  `Ready: admin-desktop/${TEST ? 'release-test' : 'release'}/${artifact}`,
);
