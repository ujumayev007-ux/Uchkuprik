import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const target = new URL('../.env', import.meta.url);
const example = await readFile(
  new URL('../.env.example', import.meta.url),
  'utf8',
);
const password = randomBytes(32).toString('hex');

try {
  await writeFile(
    target,
    example.replaceAll('REPLACE_WITH_RANDOM_PASSWORD', password),
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
  console.log('Existing .env preserved.');
}
