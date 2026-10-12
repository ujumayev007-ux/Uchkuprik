import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Seeds a fresh demo business in the real database for each run. Values reach the
// test workers through the environment.
export default function globalSetup() {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const password = `E2e-${randomBytes(9).toString('base64url')}1`;
  const pin = String(1000 + (randomBytes(2).readUInt16BE() % 9000));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = {
    stdio: 'inherit' as const,
    shell: process.platform === 'win32',
  };
  execFileSync(npm, ['run', 'db:migrate', '-w', 'backend'], options);
  execFileSync(npm, ['run', 'seed:demo', '-w', 'backend'], {
    ...options,
    env: {
      ...process.env,
      DEMO_TENANT_SLUG: slug,
      DEMO_PASSWORD: password,
      DEMO_CASHIER_PIN: pin,
    },
  });
  process.env.E2E_TENANT = slug;
  process.env.E2E_PASSWORD = password;
  process.env.E2E_PIN = pin;
}
