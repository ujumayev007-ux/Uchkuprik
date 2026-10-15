// Builds the Owner installer: FastFood-Owner-Setup-<version>.exe
// Shares the vendor tools with the customer app (../desktop/vendor-*.cjs, reports.cjs).
// Only PUBLIC data is baked in: the central server's address (OWNER_URL).
// Code signing: set CSC_LINK / CSC_KEY_PASSWORD (a .pfx) and electron-builder signs
// the installer; unsigned builds are for internal testing only.
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
const require = createRequire(import.meta.url);
const { version } = JSON.parse(
  readFileSync(join(here, 'package.json'), 'utf8'),
);
// BUILD_CHANNEL=test: isolated TEST installer that may point at a local http
// address (127.0.0.1) and uses its own app id and output folder.
const TEST = process.env.BUILD_CHANNEL === 'test';
const url = (process.env.OWNER_URL || '').trim();
const localOk =
  TEST && /^http:[/][/](127[.]0[.]0[.]1|localhost):[0-9]+$/.test(url);
if (!url.startsWith('https://') && !localOk)
  throw new Error('Set OWNER_URL to the central server HTTPS address.');

const stage = join(here, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const name of ['vendor-ipc.cjs', 'vendor-alerts.cjs', 'reports.cjs'])
  copyFileSync(join(here, '..', 'desktop', name), join(stage, name));
writeFileSync(
  join(stage, 'owner.json'),
  JSON.stringify({ url, ...(TEST ? { test: true } : {}) }),
);
for (const name of ['main.cjs', 'preload.cjs'])
  copyFileSync(join(here, name), join(stage, name));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'fastfood-owner',
    productName: 'FastFood Owner',
    version,
    main: 'main.cjs',
    author: 'FAST FOOD',
  }),
);

const { build } = require('electron-builder');
await build({
  projectDir: stage,
  config: {
    appId: TEST ? 'uz.fastfood.owner.test' : 'uz.fastfood.owner',
    productName: TEST ? 'FastFood Owner TEST' : 'FastFood Owner',
    executableName: TEST ? 'FastFoodOwnerTest' : 'FastFoodOwner',
    electronVersion: require('electron/package.json').version,
    directories: { output: join(here, TEST ? 'release-test' : 'release') },
    files: ['**/*', '!owner.json'],
    extraResources: [{ from: join(stage, 'owner.json'), to: 'owner.json' }],
    asar: true,
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      artifactName: `FastFood-Owner${TEST ? '-TEST' : ''}-Setup-${version}.exe`,
      deleteAppDataOnUninstall: false,
    },
  },
});
const out = join(here, TEST ? 'release-test' : 'release');
const name = `FastFood-Owner${TEST ? '-TEST' : ''}-Setup-${version}.exe`;
if (!existsSync(join(out, name)))
  throw new Error('Owner installer was not produced.');
console.log(
  `Ready: owner-desktop/${TEST ? 'release-test' : 'release'}/${name}`,
);
