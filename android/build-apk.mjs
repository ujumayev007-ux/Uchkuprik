// Builds android/release/FastFood-<version>.apk (signed).
// The version comes from desktop/package.json so EXE and APK always match.
// The signing key is created once in %USERPROFILE%\.fastfood (never committed);
// keep that folder safe: later APKs must be signed with the same key.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(here, '..', 'desktop', 'package.json'), 'utf8'),
);
// waiter (default) or tv: both are built from the same code (see app/build.gradle).
const kind = process.argv[2] === 'tv' ? 'tv' : 'waiter';
const javaHome = process.env.JAVA_HOME;
const gradle = process.env.GRADLE_BIN;
const sdk =
  process.env.ANDROID_HOME ??
  join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
if (!javaHome || !gradle)
  throw new Error('Set JAVA_HOME (JDK 17+) and GRADLE_BIN (gradle.bat).');

writeFileSync(
  join(here, 'local.properties'),
  `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`,
);

const keys = join(homedir(), '.fastfood');
const keystore = join(keys, 'android-release.jks');
const passwordFile = join(keys, 'android-release.password');
mkdirSync(keys, { recursive: true });
if (!existsSync(keystore)) {
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passwordFile, password, { mode: 0o600 });
  execFileSync(
    join(javaHome, 'bin', 'keytool.exe'),
    [
      '-genkeypair',
      '-v',
      '-keystore',
      keystore,
      '-alias',
      'fastfood',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      password,
      '-keypass',
      password,
      '-dname',
      'CN=FAST FOOD, O=FAST FOOD, C=UZ',
    ],
    { stdio: 'inherit' },
  );
}
const password = readFileSync(passwordFile, 'utf8').trim();

execFileSync(
  gradle,
  [
    '--no-daemon',
    '-q',
    `-PappVersion=${version}`,
    `-PappKind=${kind}`,
    ':app:assembleRelease',
  ],
  {
    cwd: here,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      JAVA_HOME: javaHome,
      FASTFOOD_KEYSTORE: keystore,
      FASTFOOD_KEYSTORE_PASSWORD: password,
    },
  },
);

const output = join(
  here,
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk',
);
mkdirSync(join(here, 'release'), { recursive: true });
const target = join(
  here,
  'release',
  kind === 'tv' ? `FastFood-TV-${version}.apk` : `FastFood-${version}.apk`,
);
copyFileSync(output, target);
console.log(`Ready: ${target}`);
