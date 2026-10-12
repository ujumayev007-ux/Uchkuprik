import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const target = new URL('../.env', import.meta.url);
const example = await readFile(
  new URL('../.env.example', import.meta.url),
  'utf8',
);
const password = randomBytes(32).toString('hex');
const secretKey = randomBytes(32).toString('base64');

try {
  await writeFile(
    target,
    example
      .replaceAll('REPLACE_WITH_RANDOM_PASSWORD', password)
      .replaceAll('REPLACE_WITH_RANDOM_SECRET_KEY', secretKey),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  console.log(
    'Created local .env. Credentials were generated and were not printed.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  // Add settings introduced after the file was created; never change existing values.
  const current = await readFile(target, 'utf8');
  if (!/^APP_SECRET_KEY=/m.test(current)) {
    await appendFile(
      target,
      `
APP_SECRET_KEY=${secretKey}
`,
    );
    console.log('Existing .env preserved; added a generated APP_SECRET_KEY.');
  } else console.log('Existing .env preserved.');
}
