// Logical backup, restore check and restore.
//   npm run backup -w backend -- create <file>
//   npm run backup -w backend -- verify <file>        (restores into a scratch DB)
//   npm run backup -w backend -- restore <file>        (target must be empty+migrated)
// `create` also verifies the new file by default; pass --no-verify to skip.
import { stat } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import {
  createBackup,
  loadBackup,
  verifyBackup,
  type BackupSummary,
} from '../lib/backup.js';

const [command, file, flag] = process.argv.slice(2);
const config = loadConfig();

async function main() {
  if (!file || !['create', 'verify', 'restore'].includes(command ?? '')) {
    console.error('Usage: backup <create|verify|restore> <file> [--no-verify]');
    process.exitCode = 2;
    return;
  }
  if (command === 'create') {
    const summary = await createBackup(config.DATABASE_URL, file);
    console.log(
      `Backup written: ${file} (${summary.tables.length} tables, ${summary.totalRows} rows, ${summary.bytes} bytes)`,
    );
    if (flag !== '--no-verify') {
      const result = await verifyBackup(config.DATABASE_URL, file, summary);
      console.log(
        result.ok
          ? `Restore check passed: ${result.rows} rows in ${result.tables} tables.`
          : `Restore check FAILED: ${JSON.stringify(result.mismatches)}`,
      );
      process.exitCode = result.ok ? 0 : 1;
    }
    return;
  }
  await stat(file);
  if (command === 'restore') {
    const summary = await loadBackup(config.DATABASE_URL, file);
    console.log(`Restored ${summary.totalRows} rows.`);
    return;
  }
  // verify: the expected counts come from the file itself.
  const expected: BackupSummary = { tables: [], totalRows: 0, bytes: 0 };
  const { createReadStream } = await import('node:fs');
  const { createGunzip } = await import('node:zlib');
  const { createInterface } = await import('node:readline');
  let current: { name: string; rows: number } | null = null;
  for await (const line of createInterface({
    input: createReadStream(file).pipe(createGunzip()),
  })) {
    const item = JSON.parse(line) as { table?: string; r?: unknown };
    if (item.table) {
      current = { name: item.table, rows: 0 };
      expected.tables.push(current);
    } else if (item.r && current) current.rows++;
  }
  const result = await verifyBackup(config.DATABASE_URL, file, expected);
  console.log(
    result.ok
      ? `Restore check passed: ${result.rows} rows in ${result.tables} tables.`
      : `Restore check FAILED: ${JSON.stringify(result.mismatches)}`,
  );
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(() => {
  console.error('Backup failed.');
  process.exitCode = 1;
});
