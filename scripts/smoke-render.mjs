import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reserve = createServer();
await new Promise((resolve, reject) => {
  reserve.once('error', reject);
  reserve.listen(0, '127.0.0.1', resolve);
});
const address = reserve.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise((resolve) => reserve.close(resolve));

let startupOutput = '';
const service = spawn(process.execPath, ['scripts/start.mjs'], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    RENDER: 'true',
    RENDER_EXTERNAL_URL: 'https://uchkuprikfastfood.onrender.com',
    APP_ORIGIN: 'https://uchkuprikfastfood.onrender.com',
    HOST: '127.0.0.1',
    PORT: String(port),
    // Deliberately unavailable endpoint: the deployment smoke test must not fake readiness.
    DATABASE_URL:
      'postgresql://smoke@127.0.0.1:1/unavailable?sslmode=verify-full',
  },
});
service.stdout.on('data', (chunk) => {
  startupOutput += chunk;
});
service.stderr.on('data', (chunk) => {
  startupOutput += chunk;
});
const closed = new Promise((resolve) => service.once('close', resolve));
const base = `http://127.0.0.1:${port}`;
try {
  await new Promise((resolve, reject) => {
    service.once('error', reject);
    const deadline = Date.now() + 10000;
    const poll = async () => {
      if (service.exitCode !== null)
        return reject(new Error(`Compiled service exited: ${startupOutput}`));
      try {
        const response = await fetch(`${base}/api/health/live`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return resolve();
      } catch {
        /* The server may still be binding its socket. */
      }
      if (Date.now() >= deadline)
        return reject(new Error('Compiled service startup timed out.'));
      setTimeout(poll, 100);
    };
    void poll();
  });
  const document = await fetch(base);
  assert.equal(document.status, 200);
  assert.match(
    document.headers.get('content-security-policy') ?? '',
    /default-src 'self'/,
  );
  const html = await document.text();
  assert.match(html, /<html lang="uz">/);
  const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/);
  assert(asset, 'Built frontend JavaScript must be referenced.');
  assert.equal((await fetch(`${base}${asset[1]}`)).status, 200);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/backend/src/server.ts`)).status, 404);
  const readiness = await fetch(`${base}/api/health/ready`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).status, 'unavailable');
  console.log(
    'Compiled single-service deployment passed: Uzbek frontend, assets, API, security boundaries, and truthful database failure.',
  );
} finally {
  service.kill('SIGTERM');
  await closed;
}
