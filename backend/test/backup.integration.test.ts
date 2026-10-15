import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createBackup, verifyBackup } from '../src/lib/backup.js';
import { createTenant, createTestContext } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

describe('backup and restore verification', () => {
  it('writes a backup and proves it restores table by table', async () => {
    await createTenant(ctx);
    const url = loadConfig().DATABASE_URL;
    const dir = mkdtempSync(join(tmpdir(), 'ff-backup-'));
    try {
      const file = join(dir, 'backup.ndjson.gz');
      const summary = await createBackup(url, file);
      expect(summary.totalRows).toBeGreaterThan(0);
      expect(summary.tables.some((table) => table.name === 'tenants')).toBe(
        true,
      );
      const result = await verifyBackup(url, file, summary);
      expect(result.mismatches).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.rows).toBe(summary.totalRows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
