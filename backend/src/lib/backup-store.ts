import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import pg from 'pg';
import { AppError } from '../http/errors.js';
import { partialRestore, type PartialGroup } from './backup-partial.js';
import {
  createBackup,
  loadBackup,
  verifyBackup,
  type BackupSummary,
} from './backup.js';

/**
 * Backups kept in the restaurant computer's data folder, each with a small manifest
 * (`<file>.json`): what it holds and whether it restored cleanly. A restore never
 * touches the running database: the backup is loaded into a new database and the
 * desktop launcher swaps the two while the server is stopped, keeping the old one.
 */

export const BACKUP_KINDS = [
  'daily',
  'manual',
  'pre-restore',
  'imported',
] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];
const KEEP: Record<BackupKind, number> = {
  daily: 7,
  manual: 20,
  'pre-restore': 10,
  imported: 10,
};
const NAME = /^(daily|manual|pre-restore|imported)-[0-9A-Za-z-]+\.ndjson\.gz$/;
// The database the server uses, and the ones a restore keeps (never deleted here).
const LIVE_DB = 'fastfood';
const KEPT_DB = /^fastfood_before_[0-9]{8,20}$/;
// The computer's identity, licence and Owner operation receipts stay as they are now.
const CARRY_TABLES = ['control_link', 'app_license', 'remote_op_receipts'];
const MAGIC = Buffer.from('FFBK1');
const MIGRATIONS = fileURLToPath(
  new URL('../../prisma/migrations/', import.meta.url),
);

export type BackupInfo = {
  name: string;
  kind: BackupKind;
  createdAt: string;
  bytes: number;
  tables: number | null;
  totalRows: number | null;
  verified: boolean | null;
  sha256: string | null;
};
export type BackupStatus = {
  lastAt: string | null;
  ok: boolean | null;
  lastName: string | null;
  count: number;
};

const unavailable = () =>
  new AppError(409, 'BACKUP_UNAVAILABLE', 'backupUnavailable');
const notFound = () => new AppError(404, 'NOT_FOUND', 'notFound');
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const stamp = (at = new Date()) =>
  at
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);

function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function sha256Of(file: string) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Table row counts recorded inside a backup file. */
export async function contentsOf(file: string): Promise<BackupSummary> {
  const summary: BackupSummary = { tables: [], totalRows: 0, bytes: 0 };
  let current: { name: string; rows: number } | null = null;
  let first = true;
  for await (const line of createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    const item = JSON.parse(line) as {
      format?: string;
      table?: string;
      r?: unknown;
    };
    if (first) {
      if (item.format !== 'fastfood-backup/1')
        throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
      first = false;
      continue;
    }
    if (item.table) {
      current = { name: item.table, rows: 0 };
      summary.tables.push(current);
    } else if (item.r && current) {
      current.rows++;
      summary.totalRows++;
    }
  }
  if (first) throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
  summary.bytes = (await stat(file)).size;
  return summary;
}

/** Writes the manifest next to a backup file (also used by the daily backup CLI). */
export async function writeManifest(
  file: string,
  kind: BackupKind,
  summary: BackupSummary,
  verified: boolean | null,
) {
  await writeFile(
    `${file}.json`,
    JSON.stringify({
      kind,
      createdAt: new Date().toISOString(),
      bytes: summary.bytes,
      tables: summary.tables.length,
      totalRows: summary.totalRows,
      verified,
      sha256: await sha256Of(file),
    }),
    { mode: 0o600 },
  );
}

/** Last backup result, read by the Owner heartbeat. */
export async function writeStatus(dir: string, name: string, ok: boolean) {
  await writeFile(
    `${dir}/status.json`,
    JSON.stringify({ lastAt: new Date().toISOString(), ok, lastName: name }),
    { mode: 0o600 },
  );
}

function keyFor(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      32,
      { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

export type BackupStore = ReturnType<typeof backupStore>;

/**
 * `dir`: the backup folder; `dataDir`: where the launcher looks for a pending database
 * swap; `canSwap`: the launcher of this install performs swaps.
 */
export function backupStore(options: {
  dir: string;
  dataDir: string | null;
  databaseUrl: string;
  canSwap: boolean;
}) {
  const { dir, dataDir, databaseUrl, canSwap } = options;
  const fileOf = (name: string) => {
    if (!NAME.test(name)) throw notFound();
    return `${dir}/${name}`;
  };
  const kindOf = (name: string) =>
    name
      .split('-')
      .slice(0, name.startsWith('pre-restore') ? 2 : 1)
      .join('-') as BackupKind;

  async function list(): Promise<BackupInfo[]> {
    await mkdir(dir, { recursive: true });
    const names = (await readdir(dir)).filter((name) => NAME.test(name));
    const rows = await Promise.all(
      names.map(async (name): Promise<BackupInfo | null> => {
        const info = await stat(`${dir}/${name}`).catch(() => null);
        if (!info) return null;
        const manifest = await readFile(`${dir}/${name}.json`, 'utf8')
          .then((text) => JSON.parse(text) as Partial<BackupInfo>)
          .catch(() => ({}) as Partial<BackupInfo>);
        return {
          name,
          kind: kindOf(name),
          createdAt: manifest.createdAt ?? info.mtime.toISOString(),
          bytes: info.size,
          tables: manifest.tables ?? null,
          totalRows: manifest.totalRows ?? null,
          verified: manifest.verified ?? null,
          sha256: manifest.sha256 ?? null,
        };
      }),
    );
    return rows
      .filter((row): row is BackupInfo => row !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function prune(kind: BackupKind) {
    const old = (await list())
      .filter((row) => row.kind === kind)
      .slice(KEEP[kind]);
    for (const row of old) {
      await rm(`${dir}/${row.name}`, { force: true });
      await rm(`${dir}/${row.name}.json`, { force: true });
    }
  }

  /** A new backup, trusted only after it restored cleanly into a scratch database. */
  async function create(kind: BackupKind): Promise<BackupInfo> {
    await mkdir(dir, { recursive: true });
    const name = `${kind}-${stamp()}-${randomBytes(2).toString('hex')}.ndjson.gz`;
    const file = `${dir}/${name}`;
    try {
      const summary = await createBackup(databaseUrl, file);
      const check = await verifyBackup(databaseUrl, file, summary);
      if (!check.ok)
        throw new AppError(500, 'BACKUP_VERIFY_FAILED', 'backupVerifyFailed');
      await writeManifest(file, kind, summary, true);
      await writeStatus(dir, name, true);
    } catch (error) {
      await rm(file, { force: true });
      await writeStatus(dir, name, false).catch(() => undefined);
      throw error instanceof AppError
        ? error
        : new AppError(500, 'BACKUP_FAILED', 'backupFailed');
    }
    await prune(kind);
    return (await list()).find((row) => row.name === name)!;
  }

  /** Restores a stored backup into a scratch database and compares every table. */
  async function verify(name: string) {
    const file = fileOf(name);
    const expected = await contentsOf(file).catch(() => {
      throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
    });
    const result = await verifyBackup(databaseUrl, file, expected);
    const manifest = await readFile(`${file}.json`, 'utf8')
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null);
    if (manifest)
      await writeFile(
        `${file}.json`,
        JSON.stringify({ ...manifest, verified: result.ok }),
      );
    else await writeManifest(file, kindOf(name), expected, result.ok);
    return result;
  }

  /** The backup encrypted with a password (AES-256-GCM, scrypt key): FFBK1|salt|iv|data|tag. */
  async function exportEncrypted(
    name: string,
    password: string,
    out: Writable,
  ) {
    const file = fileOf(name);
    await stat(file).catch(() => {
      throw notFound();
    });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      await keyFor(password, salt),
      iv,
    );
    out.write(Buffer.concat([MAGIC, salt, iv]));
    for await (const chunk of createReadStream(file).pipe(cipher))
      if (!out.write(chunk)) await once(out, 'drain');
    out.end(cipher.getAuthTag());
  }

  /** Decrypts an uploaded export into the backup folder and checks it restores. */
  async function importEncrypted(
    upload: string,
    password: string,
  ): Promise<BackupInfo> {
    const size = (await stat(upload)).size;
    const handle = await open(upload, 'r');
    const head = Buffer.alloc(MAGIC.length + 28);
    const tag = Buffer.alloc(16);
    try {
      if (size < head.length + tag.length)
        throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
      await handle.read(head, 0, head.length, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    if (!head.subarray(0, MAGIC.length).equals(MAGIC))
      throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
    const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = head.subarray(MAGIC.length + 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      await keyFor(password, salt),
      iv,
    );
    decipher.setAuthTag(tag);
    const name = `imported-${stamp()}-${randomBytes(2).toString('hex')}.ndjson.gz`;
    const file = `${dir}/${name}`;
    await mkdir(dir, { recursive: true });
    try {
      await pipeline(
        createReadStream(upload, { start: head.length, end: size - 17 }),
        decipher,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch {
      await rm(file, { force: true });
      // Wrong password or a damaged file: GCM refuses both.
      throw new AppError(400, 'BACKUP_PASSWORD', 'backupPassword');
    }
    try {
      const summary = await contentsOf(file);
      const check = await verifyBackup(databaseUrl, file, summary);
      if (!check.ok) throw new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
      await writeManifest(file, 'imported', summary, true);
    } catch (error) {
      await rm(file, { force: true });
      throw error instanceof AppError
        ? error
        : new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
    }
    await prune('imported');
    return (await list()).find((row) => row.name === name)!;
  }

  async function admin<T>(work: (client: pg.Client) => Promise<T>) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Databases kept by earlier restores (the state before each restore). */
  async function keptDatabases(): Promise<string[]> {
    return admin(async (client) =>
      (
        await client.query<{ name: string }>(
          `SELECT datname AS name FROM pg_database WHERE datname LIKE 'fastfood\\_before\\_%' ORDER BY datname DESC`,
        )
      ).rows
        .map((row) => row.name)
        .filter((name) => KEPT_DB.test(name)),
    );
  }

  const pendingFile = () => {
    if (!dataDir || !canSwap) throw unavailable();
    return `${dataDir}/restore-pending.json`;
  };

  /**
   * Prepares a restore: a backup of the current state first, then the chosen backup in
   * a new database (migrated like the live one, identity tables carried over). The
   * launcher swaps it in when the server restarts; the current database is kept.
   */
  async function prepareRestore(name: string) {
    const pending = pendingFile();
    const file = fileOf(name);
    const expected = await contentsOf(file);
    const before = await create('pre-restore');
    const database = `fastfood_restore_${stamp()}`;
    const target = withDatabase(databaseUrl, database);
    await admin((client) =>
      client.query(
        `CREATE DATABASE ${quote(database)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      ),
    );
    try {
      const migrated = new pg.Client({ connectionString: target });
      await migrated.connect();
      try {
        // Same bookkeeping as the launcher's migrations: nothing is applied twice.
        await migrated.query(`CREATE TABLE "_prisma_migrations" (
          "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
          "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
          "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`);
        const names = (await readdir(MIGRATIONS, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        for (const migration of names) {
          const sql = await readFile(
            `${MIGRATIONS}${migration}/migration.sql`,
            'utf8',
          );
          await migrated.query(sql);
          await migrated.query(
            'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (gen_random_uuid()::text, $1, now(), $2, 1)',
            [createHash('sha256').update(sql).digest('hex'), migration],
          );
        }
      } finally {
        await migrated.end();
      }
      const restored = await loadBackup(target, file);
      const check = new pg.Client({ connectionString: target });
      await check.connect();
      try {
        for (const table of expected.tables) {
          if (CARRY_TABLES.includes(table.name)) continue;
          const actual = Number(
            (
              await check.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM ${quote(table.name)}`,
              )
            ).rows[0]!.n,
          );
          if (actual !== table.rows)
            throw new AppError(
              500,
              'BACKUP_VERIFY_FAILED',
              'backupVerifyFailed',
            );
        }
        // This computer's identity, licence and operation receipts: today's rows.
        const live = new pg.Client({ connectionString: databaseUrl });
        await live.connect();
        try {
          await check.query('BEGIN');
          for (const table of CARRY_TABLES) {
            await check.query(`DELETE FROM ${quote(table)}`);
            const rows = await live.query<{ r: unknown }>(
              `SELECT row_to_json(t) AS r FROM ${quote(table)} t`,
            );
            for (const row of rows.rows)
              await check.query(
                `INSERT INTO ${quote(table)} SELECT * FROM json_populate_record(NULL::${quote(table)}, $1::json)`,
                [JSON.stringify(row.r)],
              );
          }
          await check.query('COMMIT');
        } finally {
          await live.end();
        }
      } finally {
        await check.end();
      }
      await writeFile(
        `${pending}.tmp`,
        JSON.stringify({
          action: 'restore',
          database,
          backup: name,
          preRestore: before.name,
          at: new Date().toISOString(),
        }),
      );
      await rename(`${pending}.tmp`, pending);
      return {
        database,
        backup: name,
        preRestore: before.name,
        rows: restored.totalRows,
      };
    } catch (error) {
      await admin((client) =>
        client.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`),
      ).catch(() => undefined);
      throw error instanceof AppError
        ? error
        : new AppError(500, 'BACKUP_FAILED', 'backupFailed');
    }
  }

  /** Puts a database kept by an earlier restore back in use (after a restart). */
  async function prepareRollback(database: string) {
    const pending = pendingFile();
    if (!KEPT_DB.test(database) || !(await keptDatabases()).includes(database))
      throw notFound();
    await writeFile(
      `${pending}.tmp`,
      JSON.stringify({
        action: 'rollback',
        database,
        at: new Date().toISOString(),
      }),
    );
    await rename(`${pending}.tmp`, pending);
    return { database };
  }

  /** Where an uploaded export waits for its password. */
  async function uploadTarget(id: string) {
    if (!/^[0-9a-f]{24}$/.test(id)) throw notFound();
    await mkdir(`${dir}/uploads`, { recursive: true });
    return `${dir}/uploads/${id}.part`;
  }

  async function status(): Promise<BackupStatus> {
    const last = await readFile(`${dir}/status.json`, 'utf8')
      .then((text) => JSON.parse(text) as Partial<BackupStatus>)
      .catch(() => ({}) as Partial<BackupStatus>);
    const rows = await list().catch(() => []);
    // Older daily backups wrote no status: the newest file counts.
    const newest = rows[0];
    return {
      lastAt: last.lastAt ?? newest?.createdAt ?? null,
      ok: last.ok ?? (newest ? newest.verified !== false : null),
      lastName: last.lastName ?? newest?.name ?? null,
      count: rows.length,
    };
  }

  /**
   * Qisman tiklash into the live database: a dry run reports what would change; the
   * real one first keeps a full pre-restore backup (to undo with a full restore).
   */
  async function partial(
    name: string,
    groups: PartialGroup[],
    options: { dryRun: boolean },
  ) {
    const file = fileOf(name);
    await stat(file).catch(() => {
      throw notFound();
    });
    const safety = options.dryRun ? null : await create('pre-restore');
    try {
      const result = await partialRestore(databaseUrl, file, groups, options);
      return { ...result, safetyBackup: safety?.name ?? null };
    } catch {
      throw new AppError(
        409,
        'BACKUP_PARTIAL_CONFLICT',
        'backupPartialConflict',
      );
    }
  }

  return {
    list,
    create,
    verify,
    partial,
    exportEncrypted,
    importEncrypted,
    keptDatabases,
    prepareRestore,
    prepareRollback,
    uploadTarget,
    status,
    canRestore: Boolean(dataDir && canSwap),
    liveDatabase: LIVE_DB,
  };
}
