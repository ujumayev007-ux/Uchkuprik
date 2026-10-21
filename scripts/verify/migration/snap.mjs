// Content snapshot of a FastFood data folder WITHOUT touching it: the pgdata folder is copied
// to a temporary place, PostgreSQL is started on the copy (trust login, own port), every table
// of schema "public" is read (row count + a fingerprint of every row), then the copy is removed.
//   node snap.mjs <dataDir> <out.json> [--ref before.json] [--port 55501] [--pgbin <dir>]
// With --ref, rows are fingerprinted over the columns the reference snapshot had, so data
// stays comparable after migrations added columns.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const dataDir = path.resolve(args[0]);
const outFile = path.resolve(args[1]);
const refFile = flag('--ref');
const port = Number(flag('--port', '55501'));
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
// The same PostgreSQL major version the application ships (17).
const pgBin = flag(
  '--pgbin',
  path.join(
    repo,
    'desktop',
    'node_modules',
    '@embedded-postgres',
    'windows-x64',
    'native',
    'bin',
  ),
);
const require = createRequire(path.join(repo, 'backend', 'package.json'));
const { Client } = require('pg');

const src = path.join(dataDir, 'pgdata');
if (!fs.existsSync(path.join(src, 'PG_VERSION')))
  throw new Error('no pgdata in ' + dataDir);
if (fs.existsSync(path.join(src, 'postmaster.pid')))
  throw new Error(
    'postmaster.pid present: the data folder is in use (or was not shut down cleanly)',
  );
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-snap-'));
const copy = path.join(tmp, 'pgdata');
fs.cpSync(src, copy, { recursive: true });
fs.writeFileSync(
  path.join(copy, 'pg_hba.conf'),
  'host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nlocal all all trust\n',
);
const pgctl = path.join(pgBin, 'pg_ctl.exe');
const stop = () =>
  spawnSync(pgctl, ['-D', copy, '-m', 'fast', '-w', 'stop'], {
    windowsHide: true,
  });
const started = spawnSync(
  pgctl,
  [
    '-D',
    copy,
    '-l',
    path.join(tmp, 'pg.log'),
    '-w',
    '-t',
    '60',
    '-o',
    `-p ${port} -c listen_addresses=127.0.0.1`,
    'start',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
if (started.status !== 0) {
  console.error(
    fs.existsSync(path.join(tmp, 'pg.log'))
      ? fs.readFileSync(path.join(tmp, 'pg.log'), 'utf8').slice(-1500)
      : 'pg_ctl failed',
  );
  throw new Error('PostgreSQL did not start on the copy');
}
let result;
try {
  const ref = refFile ? JSON.parse(fs.readFileSync(refFile, 'utf8')) : null;
  const db = new Client({
    host: '127.0.0.1',
    port,
    user: 'fastfood',
    database: 'fastfood',
  });
  await db.connect();
  const meta = (
    await db.query(
      "select version() v, (select datcollate from pg_database where datname='fastfood') collate, (select pg_encoding_to_char(encoding) from pg_database where datname='fastfood') enc",
    )
  ).rows[0];
  const tables = (
    await db.query(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1",
    )
  ).rows.map((r) => r.table_name);
  const snapshot = {
    takenAt: new Date().toISOString(),
    meta,
    tables: {},
    migrations: [],
  };
  snapshot.migrations = (
    await db.query(
      'select migration_name from "_prisma_migrations" where finished_at is not null order by migration_name',
    )
  ).rows.map((r) => r.migration_name);
  for (const table of tables) {
    const columns = (
      await db.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by column_name",
        [table],
      )
    ).rows.map((r) => r.column_name);
    const refColumns = ref?.tables?.[table]?.columns;
    const use = refColumns
      ? refColumns.filter((c) => columns.includes(c))
      : columns;
    const missingColumns = refColumns
      ? refColumns.filter((c) => !columns.includes(c))
      : [];
    const count = Number(
      (await db.query(`select count(*) c from "${table}"`)).rows[0].c,
    );
    let hashes = [];
    if (use.length && count > 0) {
      const expr = use
        .map((c) => `coalesce("${c}"::text, E'\\\\N')`)
        .join(', ');
      hashes = (
        await db.query(
          `select md5(concat_ws(E'\\x1f', ${expr})) h from "${table}"`,
        )
      ).rows
        .map((r) => r.h)
        .sort();
    }
    snapshot.tables[table] = {
      columns,
      count,
      used: use,
      missingColumns,
      hashes,
    };
  }
  await db.end();
  result = snapshot;
} finally {
  stop();
}
fs.writeFileSync(outFile, JSON.stringify(result));
// The temporary copy goes away once PostgreSQL has released its files (retry: Windows locks).
for (let i = 0; i < 10; i++) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (i === 9) console.warn('note: temporary copy left at', tmp);
  }
}
const withRows = Object.entries(result.tables).filter(([, v]) => v.count > 0);
console.log(
  `snapshot: ${Object.keys(result.tables).length} tables, ${withRows.length} with rows, ${withRows.reduce((s, [, v]) => s + v.count, 0)} rows, ${result.migrations.length} migrations -> ${outFile}`,
);
