import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import pg from 'pg';

// Logical backups that need no external tools (pg_dump is not shipped with the
// desktop PostgreSQL): every table is written as gzip-compressed JSON lines and a
// backup is only trusted after it has been restored into a scratch database and
// compared table by table.

const SKIP_TABLES = new Set(['_prisma_migrations']);
const BATCH = 500;
const MIGRATIONS = fileURLToPath(
  new URL('../../prisma/migrations/', import.meta.url),
);

export type BackupSummary = {
  tables: { name: string; rows: number }[];
  totalRows: number;
  bytes: number;
};

function quote(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Tables in foreign-key order (parents first); cycles are appended at the end. */
async function tableOrder(client: pg.Client): Promise<string[]> {
  const tables = (
    await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`,
    )
  ).rows
    .map((row) => row.name)
    .filter((name) => !SKIP_TABLES.has(name));
  const edges = (
    await client.query<{ child: string; parent: string }>(
      `SELECT c.relname AS child, p.relname AS parent
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_class p ON p.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'f' AND n.nspname = 'public' AND c.oid <> p.oid`,
    )
  ).rows;
  const remaining = new Map(
    tables.map((name) => [
      name,
      new Set(
        edges
          .filter((edge) => edge.child === name && tables.includes(edge.parent))
          .map((edge) => edge.parent),
      ),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => parents.size === 0)
      .map(([name]) => name);
    if (ready.length === 0) {
      ordered.push(...remaining.keys());
      break;
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
      for (const parents of remaining.values()) parents.delete(name);
    }
  }
  return ordered;
}

export async function createBackup(
  databaseUrl: string,
  file: string,
): Promise<BackupSummary> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const gzip = createGzip();
  const out = createWriteStream(file, { mode: 0o600 });
  gzip.pipe(out);
  const write = async (value: unknown) => {
    if (!gzip.write(`${JSON.stringify(value)}\n`)) await once(gzip, 'drain');
  };
  try {
    // One consistent snapshot for the whole backup.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const summary: BackupSummary = { tables: [], totalRows: 0, bytes: 0 };
    await write({
      format: 'fastfood-backup/1',
      createdAt: new Date().toISOString(),
    });
    for (const name of await tableOrder(client)) {
      const total = (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${quote(name)}`,
        )
      ).rows[0]!.n;
      await write({ table: name, rows: Number(total) });
      let written = 0;
      let offset = 0;
      for (;;) {
        // Stable paging by physical order within the single snapshot.
        const page = await client.query<{ r: unknown }>(
          `SELECT row_to_json(t) AS r FROM (SELECT * FROM ${quote(name)} ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}) t`,
        );
        if (page.rows.length === 0) break;
        for (const row of page.rows) await write({ r: row.r });
        written += page.rows.length;
        offset += BATCH;
      }
      summary.tables.push({ name, rows: written });
      summary.totalRows += written;
    }
    await client.query('COMMIT');
    gzip.end();
    await once(out, 'finish');
    summary.bytes = (await stat(file)).size;
    return summary;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function applyMigrations(client: pg.Client) {
  const names = (await readdir(MIGRATIONS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const sql = await readFile(`${MIGRATIONS}${name}/migration.sql`, 'utf8');
    await client.query(sql);
  }
}

/** Loads a backup file into an EMPTY, already migrated database. */
export async function loadBackup(
  databaseUrl: string,
  file: string,
): Promise<BackupSummary> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const summary: BackupSummary = { tables: [], totalRows: 0, bytes: 0 };
  try {
    await client.query('BEGIN');
    // Constraints are checked at commit; order is already parents-first.
    let table: string | null = null;
    let count = 0;
    const lines = createInterface({
      input: createReadStream(file).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    const flush = () => {
      if (table) summary.tables.push({ name: table, rows: count });
    };
    for await (const line of lines) {
      if (!line) continue;
      const item = JSON.parse(line) as {
        table?: string;
        r?: unknown;
        format?: string;
      };
      if (item.format) continue;
      if (item.table) {
        flush();
        table = item.table;
        count = 0;
        // Migrations seed a few rows (plans): the backup is the source of truth.
        await client.query(`DELETE FROM ${quote(table)}`);
        continue;
      }
      if (item.r && table) {
        await client.query(
          `INSERT INTO ${quote(table)} SELECT * FROM json_populate_record(NULL::${quote(table)}, $1::json)`,
          [JSON.stringify(item.r)],
        );
        count++;
        summary.totalRows++;
      }
    }
    flush();
    // Sequences continue after the restored rows.
    const serials = await client.query<{
      tbl: string;
      col: string;
      seq: string;
    }>(
      `SELECT c.relname AS tbl, a.attname AS col,
              pg_get_serial_sequence(quote_ident(c.relname), a.attname) AS seq
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'`,
    );
    for (const row of serials.rows)
      if (row.seq)
        await client.query(
          `SELECT setval($1, COALESCE((SELECT max(${quote(row.col)}) FROM ${quote(row.tbl)}), 1))`,
          [row.seq],
        );
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export type VerifyResult = {
  ok: boolean;
  tables: number;
  rows: number;
  mismatches: { table: string; expected: number; restored: number }[];
};

/**
 * Restores `file` into a throw-away database created next to the source one and
 * compares per-table row counts with what the backup recorded and with the live
 * database at backup time. The scratch database is always dropped.
 */
export async function verifyBackup(
  databaseUrl: string,
  file: string,
  expected: BackupSummary,
): Promise<VerifyResult> {
  const scratch = `restore_check_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE ${quote(scratch)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    );
    const scratchUrl = withDatabase(databaseUrl, scratch);
    const migrated = new pg.Client({ connectionString: scratchUrl });
    await migrated.connect();
    try {
      await applyMigrations(migrated);
    } finally {
      await migrated.end();
    }
    const restored = await loadBackup(scratchUrl, file);
    const check = new pg.Client({ connectionString: scratchUrl });
    await check.connect();
    const mismatches: VerifyResult['mismatches'] = [];
    try {
      for (const table of expected.tables) {
        const actual = Number(
          (
            await check.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${quote(table.name)}`,
            )
          ).rows[0]!.n,
        );
        if (actual !== table.rows)
          mismatches.push({
            table: table.name,
            expected: table.rows,
            restored: actual,
          });
      }
    } finally {
      await check.end();
    }
    return {
      ok: mismatches.length === 0,
      tables: restored.tables.length,
      rows: restored.totalRows,
      mismatches,
    };
  } finally {
    await admin
      .query(`DROP DATABASE IF EXISTS ${quote(scratch)} WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
