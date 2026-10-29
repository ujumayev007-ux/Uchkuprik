import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { backupStore } from '../src/lib/backup-store.js';
import { executeOp } from '../src/modules/remote/ops.js';
import { addUser, createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Zaxira nusxalar: verified backups, encrypted export/import, and a restore that is
// prepared in a new database (the live one untouched) with today's identity tables.

const ctx = createTestContext();
const config = loadConfig();
let dir = '';
const restart = vi.fn();
const created: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ff-backups-'));
  ctx.services.backups = backupStore({
    dir: `${dir}/backups`,
    dataDir: dir,
    databaseUrl: config.DATABASE_URL,
    canSwap: true,
  });
  ctx.services.requestRestart = restart;
});
afterAll(async () => {
  const admin = new pg.Client({ connectionString: config.DATABASE_URL });
  await admin.connect();
  for (const name of created)
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
  await ctx.close();
});
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('backups on the restaurant computer', () => {
  it('creates, verifies, exports encrypted, imports, and prepares a restore', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const category = await ctx.db.menuCategory.create({ data: { tenantId, name: 'Oldin' } });

    const backup = await post(owner, '/backups').expect(201);
    expect(backup.body).toMatchObject({ kind: 'manual', verified: true });
    expect(backup.body.totalRows).toBeGreaterThan(0);
    const name = backup.body.name as string;
    const list = await owner.get('/api/backups').expect(200);
    expect(list.body).toMatchObject({ available: true, canRestore: true });
    expect(list.body.status).toMatchObject({ ok: true, lastName: name });
    expect((await post(owner, `/backups/${name}/verify`).expect(200)).body.ok).toBe(true);

    // Encrypted export → upload → import (wrong password refused).
    const exported = await owner
      .post(`/api/backups/${name}/export`)
      .set('Origin', ORIGIN)
      .send({ password: 'Zaxira-parol-1' })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const encrypted = exported.body as Buffer;
    expect(encrypted.subarray(0, 5).toString()).toBe('FFBK1');
    // The plain backup is gzip; the export must not contain it in the clear.
    const plain = await readFile(`${dir}/backups/${name}`);
    expect(encrypted.includes(plain.subarray(0, 64))).toBe(false);
    const upload = async () =>
      (
        await owner
          .post('/api/backups/upload')
          .set('Origin', ORIGIN)
          .set('Content-Type', 'application/octet-stream')
          .send(encrypted)
          .expect(201)
      ).body.uploadId as string;
    const wrong = await post(owner, '/backups/import', {
      uploadId: await upload(),
      password: 'Boshqa-parol-2',
    }).expect(400);
    expect(wrong.body.code).toBe('BACKUP_PASSWORD');
    const imported = await post(owner, '/backups/import', {
      uploadId: await upload(),
      password: 'Zaxira-parol-1',
    }).expect(201);
    expect(imported.body).toMatchObject({ kind: 'imported', verified: true });

    // Changes after the backup; the computer's identity changes too.
    await ctx.db.menuCategory.create({ data: { tenantId, name: 'Keyin' } });
    const receiptId = '0190f000-0000-7000-8000-00000000abcd';
    await ctx.db.remoteOpReceipt.create({ data: { id: receiptId, kind: 'snapshot.menu', ok: true } });

    // Restore: confirmation word required; the live database is not touched.
    const refused = await post(owner, `/backups/${name}/restore`, { confirm: 'ha' }).expect(400);
    expect(refused.body.code).toBe('BACKUP_CONFIRM');
    const restore = await post(owner, `/backups/${name}/restore`, { confirm: 'TIKLASH' }).expect(200);
    created.push(restore.body.database);
    expect(restore.body).toMatchObject({ backup: name, restarting: true });
    expect(restore.body.preRestore).toMatch(/^pre-restore-/);
    expect(restart).toHaveBeenCalledTimes(1);
    const pending = JSON.parse(await readFile(`${dir}/restore-pending.json`, 'utf8'));
    expect(pending).toMatchObject({ action: 'restore', database: restore.body.database, backup: name });
    // Live database: unchanged.
    expect(await ctx.db.menuCategory.count({ where: { tenantId, name: 'Keyin' } })).toBe(1);
    // Prepared database: the backup's data, today's identity rows, and migrations recorded.
    const url = new URL(config.DATABASE_URL);
    url.pathname = `/${restore.body.database}`;
    const restored = new pg.Client({ connectionString: url.toString() });
    await restored.connect();
    try {
      const names = (
        await restored.query<{ name: string }>('SELECT name FROM menu_categories WHERE "tenantId" = $1', [tenantId])
      ).rows.map((row) => row.name);
      expect(names).toContain('Oldin');
      expect(names).not.toContain('Keyin');
      expect(
        (await restored.query('SELECT 1 FROM remote_op_receipts WHERE id = $1', [receiptId])).rowCount,
      ).toBe(1);
      expect(
        Number((await restored.query('SELECT count(*) AS n FROM "_prisma_migrations"')).rows[0].n),
      ).toBeGreaterThan(10);
    } finally {
      await restored.end();
    }
    expect(category.id).toBeTruthy();

    // Rollback only to a database an earlier restore kept.
    await post(owner, '/backups/rollback', { database: 'fastfood_before_20260101000000000', confirm: 'TIKLASH' }).expect(404);
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'backup.' } },
      select: { action: true },
    });
    expect(audits.map((row) => row.action).sort()).toEqual(
      ['backup.create', 'backup.export', 'backup.import', 'backup.restore', 'backup.verify'].sort(),
    );
    await ctx.db.remoteOpReceipt.delete({ where: { id: receiptId } });
  }, 240_000);

  it('other roles cannot use backups; Owner operations need the restaurant computer', async () => {
    const tenant = await createTenant(ctx);
    await addUser(ctx, tenant.tenant.id, { username: 'kassir', roleIds: [tenant.roleId('cashier')] });
    const cashier = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/backups').expect(403);
    const snapshot = (await executeOp(ctx.db, tenant.tenant.id, 'snapshot.backups', {}, {})) as {
      available: boolean;
    };
    expect(snapshot.available).toBe(false);
    await expect(executeOp(ctx.db, tenant.tenant.id, 'backup.create', {}, {})).rejects.toMatchObject({
      code: 'BACKUP_UNAVAILABLE',
    });
    await expect(
      executeOp(ctx.db, tenant.tenant.id, 'backup.restore', { name: 'manual-x.ndjson.gz', confirm: 'no' }, {}),
    ).rejects.toThrow();
    const listed = (await executeOp(ctx.db, tenant.tenant.id, 'snapshot.backups', {}, {
      backups: ctx.services.backups,
    })) as { available: boolean; backups: unknown[] };
    expect(listed.available).toBe(true);
    expect(listed.backups.length).toBeGreaterThan(0);
  });
});
