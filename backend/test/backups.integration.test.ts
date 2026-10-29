import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { backupStore } from '../src/lib/backup-store.js';
import { offsiteBackups } from '../src/lib/backup-offsite.js';
import { executeOp } from '../src/modules/remote/ops.js';
import {
  addUser,
  createTenant,
  createTestContext,
  login,
  ORIGIN,
} from './helpers.js';

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
    await admin
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .catch(() => undefined);
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
    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Oldin' },
    });

    await post(owner, '/backups/unlock').expect(200);
    const backup = await post(owner, '/backups').expect(201);
    expect(backup.body).toMatchObject({ kind: 'manual', verified: true });
    expect(backup.body.totalRows).toBeGreaterThan(0);
    const name = backup.body.name as string;
    const list = await owner.get('/api/backups').expect(200);
    expect(list.body).toMatchObject({ available: true, canRestore: true });
    expect(list.body.status).toMatchObject({ ok: true, lastName: name });
    expect(
      (await post(owner, `/backups/${name}/verify`).expect(200)).body.ok,
    ).toBe(true);

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
    await ctx.db.remoteOpReceipt.create({
      data: { id: receiptId, kind: 'snapshot.menu', ok: true },
    });

    // Restore: confirmation word required; the live database is not touched.
    const refused = await post(owner, `/backups/${name}/restore`, {
      confirm: 'ha',
    }).expect(400);
    expect(refused.body.code).toBe('BACKUP_CONFIRM');
    const restore = await post(owner, `/backups/${name}/restore`, {
      confirm: 'TIKLASH',
    }).expect(200);
    created.push(restore.body.database);
    expect(restore.body).toMatchObject({ backup: name, restarting: true });
    expect(restore.body.preRestore).toMatch(/^pre-restore-/);
    expect(restart).toHaveBeenCalledTimes(1);
    const pending = JSON.parse(
      await readFile(`${dir}/restore-pending.json`, 'utf8'),
    );
    expect(pending).toMatchObject({
      action: 'restore',
      database: restore.body.database,
      backup: name,
    });
    // Live database: unchanged.
    expect(
      await ctx.db.menuCategory.count({ where: { tenantId, name: 'Keyin' } }),
    ).toBe(1);
    // Prepared database: the backup's data, today's identity rows, and migrations recorded.
    const url = new URL(config.DATABASE_URL);
    url.pathname = `/${restore.body.database}`;
    const restored = new pg.Client({ connectionString: url.toString() });
    await restored.connect();
    try {
      const names = (
        await restored.query<{ name: string }>(
          'SELECT name FROM menu_categories WHERE "tenantId" = $1',
          [tenantId],
        )
      ).rows.map((row) => row.name);
      expect(names).toContain('Oldin');
      expect(names).not.toContain('Keyin');
      expect(
        (
          await restored.query(
            'SELECT 1 FROM remote_op_receipts WHERE id = $1',
            [receiptId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        Number(
          (
            await restored.query(
              'SELECT count(*) AS n FROM "_prisma_migrations"',
            )
          ).rows[0].n,
        ),
      ).toBeGreaterThan(10);
    } finally {
      await restored.end();
    }
    expect(category.id).toBeTruthy();

    // Rollback only to a database an earlier restore kept.
    await post(owner, '/backups/rollback', {
      database: 'fastfood_before_20260101000000000',
      confirm: 'TIKLASH',
    }).expect(404);
    const audits = await ctx.db.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'backup.' } },
      select: { action: true },
    });
    expect(audits.map((row) => row.action).sort()).toEqual(
      [
        'backup.create',
        'backup.export',
        'backup.import',
        'backup.restore',
        'backup.verify',
      ].sort(),
    );
    await ctx.db.remoteOpReceipt.delete({ where: { id: receiptId } });
  }, 240_000);

  it('other roles cannot use backups; Owner operations need the restaurant computer', async () => {
    const tenant = await createTenant(ctx);
    await addUser(ctx, tenant.tenant.id, {
      username: 'kassir',
      roleIds: [tenant.roleId('cashier')],
    });
    const cashier = ctx.agent();
    await login(cashier, tenant.slug, 'kassir').expect(200);
    await cashier.get('/api/backups').expect(403);
    const snapshot = (await executeOp(
      ctx.db,
      tenant.tenant.id,
      'snapshot.backups',
      {},
      {},
    )) as {
      available: boolean;
    };
    expect(snapshot.available).toBe(false);
    await expect(
      executeOp(ctx.db, tenant.tenant.id, 'backup.create', {}, {}),
    ).rejects.toMatchObject({
      code: 'BACKUP_UNAVAILABLE',
    });
    await expect(
      executeOp(
        ctx.db,
        tenant.tenant.id,
        'backup.restore',
        { name: 'manual-x.ndjson.gz', confirm: 'no' },
        {},
      ),
    ).rejects.toThrow();
    const listed = (await executeOp(
      ctx.db,
      tenant.tenant.id,
      'snapshot.backups',
      {},
      {
        backups: ctx.services.backups,
      },
    )) as { available: boolean; backups: unknown[] };
    expect(listed.available).toBe(true);
    expect(listed.backups.length).toBeGreaterThan(0);
  });
});

describe('partial restore (Qisman tiklash)', () => {
  it('puts the menu back from a backup in the live database; new rows stay; preview changes nothing', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const category = await ctx.db.menuCategory.create({
      data: { tenantId, name: 'Taomlar' },
    });
    const product = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Osh' },
    });
    await ctx.db.productVariant.create({
      data: {
        tenantId,
        productId: product.id,
        name: 'Standart',
        price: 30_000,
      },
    });
    const group = await ctx.db.modifierGroup.create({
      data: { tenantId, name: 'Sous' },
    });
    const customer = await ctx.db.customer.create({
      data: { tenantId, phone: '+998901234500', name: 'Aziz' },
    });
    await post(owner, '/backups/unlock').expect(200);
    const name = (await post(owner, '/backups').expect(201)).body
      .name as string;

    // After the backup: renamed, deleted, added.
    await ctx.db.product.update({
      where: { id: product.id },
      data: { name: 'Buzilgan nom' },
    });
    await ctx.db.modifierGroup.delete({ where: { id: group.id } });
    const added = await ctx.db.product.create({
      data: { tenantId, categoryId: category.id, name: 'Yangi taom' },
    });
    await ctx.db.customer.update({
      where: { id: customer.id },
      data: { name: 'Yangi ism' },
    });

    const preview = await post(owner, `/backups/${name}/partial/preview`, {
      groups: ['MENU', 'CUSTOMERS'],
    }).expect(200);
    expect(preview.body.dryRun).toBe(true);
    const row = (table: string) =>
      (
        preview.body.tables as {
          table: string;
          inserted: number;
          updated: number;
        }[]
      ).find((t) => t.table === table)!;
    expect(row('products').updated).toBeGreaterThanOrEqual(1);
    expect(row('modifier_groups').inserted).toBeGreaterThanOrEqual(1);
    // MISSING mode: an existing customer is never overwritten.
    expect(row('customers').updated).toBe(0);
    // The preview wrote nothing.
    expect(
      (await ctx.db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .name,
    ).toBe('Buzilgan nom');

    // The word must be typed in.
    await post(owner, `/backups/${name}/partial`, { groups: ['MENU'] }).expect(
      400,
    );
    const done = await post(owner, `/backups/${name}/partial`, {
      groups: ['MENU', 'CUSTOMERS'],
      confirm: 'TIKLASH',
    }).expect(200);
    expect(done.body.safetyBackup).toMatch(/^pre-restore-/);
    expect(
      (await ctx.db.product.findUniqueOrThrow({ where: { id: product.id } }))
        .name,
    ).toBe('Osh');
    expect(
      await ctx.db.modifierGroup.findUnique({ where: { id: group.id } }),
    ).not.toBeNull();
    // Rows made after the backup stay; customers keep today's data.
    expect(
      await ctx.db.product.findUnique({ where: { id: added.id } }),
    ).not.toBeNull();
    expect(
      (await ctx.db.customer.findUniqueOrThrow({ where: { id: customer.id } }))
        .name,
    ).toBe('Yangi ism');
    const audit = await ctx.db.auditLog.findFirst({
      where: { tenantId, action: 'backup.partial' },
    });
    expect(audit?.data).toMatchObject({ groups: ['MENU', 'CUSTOMERS'] });

    // Through the Owner channel: preview by default, the real one only with the word.
    const store = ctx.services.backups!;
    const viaOwner = (payload: object) =>
      executeOp(ctx.db, tenantId, 'backup.partial', payload, {
        backups: store,
      });
    await expect(
      viaOwner({ name, groups: ['FLOOR'], dryRun: false }),
    ).rejects.toThrow();
    const remote = (await viaOwner({ name, groups: ['FLOOR'] })) as {
      dryRun: boolean;
    };
    expect(remote.dryRun).toBe(true);
  }, 240_000);
});

describe('off-device copies (Zaxira nusxani boshqa joyga)', () => {
  it('encrypts the newest backup into a folder with the restaurant password; the copy imports back', async () => {
    ctx.services.offsite = offsiteBackups({
      dir: `${dir}/backups`,
      store: ctx.services.backups!,
      secrets: ctx.services.secrets,
    });
    const target = join(dir, 'fleshka');
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    await post(owner, '/backups/unlock').expect(200);
    const put = (body: object) =>
      owner.put('/api/backups/offsite').set('Origin', ORIGIN).send(body);
    expect(
      (
        await put({
          folder: 'nisbiy/yol',
          central: false,
          password: 'Zaxira-parol-2',
        }).expect(400)
      ).body.code,
    ).toBe('OFFSITE_FOLDER');
    // A destination needs the password.
    expect(
      (await put({ folder: target, central: false }).expect(400)).body.code,
    ).toBe('BACKUP_PASSWORD');
    const saved = await put({
      folder: target,
      central: true,
      keep: 2,
      password: 'Zaxira-parol-2',
    }).expect(200);
    expect(saved.body.config).toEqual({
      folder: target,
      central: true,
      keep: 2,
      hasPassword: true,
    });
    // The password is never stored or shown in the clear.
    const stored = await readFile(`${dir}/backups/offsite.json`, 'utf8');
    expect(stored).not.toContain('Zaxira-parol-2');

    await post(owner, '/backups').expect(201);
    const run = await post(owner, '/backups/offsite/run').expect(200);
    expect(run.body.state.folder).toMatchObject({ ok: true, error: null });
    // Not linked to the Owner here: the central copy reports why.
    expect(run.body.state.central).toMatchObject({ ok: false });
    expect(run.body.state.central.error).toMatch(/Owner/);
    const copies = (await readdir(target)).filter((name) =>
      name.endsWith('.ffbk'),
    );
    expect(copies).toHaveLength(1);
    const copy = await readFile(join(target, copies[0]!));
    expect(copy.subarray(0, 5).toString()).toBe('FFBK1');
    // Nothing new: the next run does not copy again.
    await post(owner, '/backups/offsite/run').expect(200);
    expect(
      (await readdir(target)).filter((name) => name.endsWith('.ffbk')),
    ).toHaveLength(1);

    // The copy opens with the password on another computer (import).
    const uploadId = (
      await owner
        .post('/api/backups/upload')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/octet-stream')
        .send(copy)
        .expect(201)
    ).body.uploadId as string;
    await post(owner, '/backups/import', {
      uploadId,
      password: 'Zaxira-parol-2',
    }).expect(201);
    const status = await owner.get('/api/backups/offsite').expect(200);
    expect(status.body.config.hasPassword).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain('Zaxira-parol-2');
  }, 240_000);
});

describe('terminals after a full restore', () => {
  it('stay as they are today: Owner approvals kept, removed or blocked ones never come back', async () => {
    const tenant = await createTenant(ctx);
    const tenantId = tenant.tenant.id;
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const user = await ctx.db.user.findFirstOrThrow({ where: { tenantId } });
    const device = (
      name: string,
      status: 'ACTIVE' | 'PENDING',
      branchId = tenant.branch.id,
    ) =>
      ctx.db.device.create({
        data: {
          tenantId,
          branchId,
          name,
          tokenHash: `test-${name}-${Math.random().toString(36).slice(2)}`,
          status,
          registeredById: user.id,
          panel: 'KITCHEN',
        },
      });
    const blocked = await device('Bloklanadi', 'ACTIVE');
    const approved = await device('Tasdiqlanadi', 'PENDING');
    const removed = await device('Ochiriladi', 'ACTIVE');
    await post(owner, '/backups/unlock').expect(200);
    const name = (await post(owner, '/backups').expect(201)).body
      .name as string;

    // After the backup: the Owner blocks one and approves one, one is removed, two added.
    await ctx.db.device.update({
      where: { id: blocked.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await ctx.db.device.update({
      where: { id: approved.id },
      data: { status: 'ACTIVE' },
    });
    await ctx.db.device.delete({ where: { id: removed.id } });
    const added = await device('Yangi', 'ACTIVE');
    const branch = await ctx.db.branch.create({
      data: { tenantId, code: `F${Date.now() % 100000}`, name: 'Yangi filial' },
    });
    await device('Yangi filialda', 'ACTIVE', branch.id);
    const pendingNew = await device('Kutmoqda', 'PENDING');

    const prepared = await ctx.services.backups!.prepareRestore(name);
    created.push(prepared.database);
    expect(prepared.terminals.needRepair).toBeGreaterThanOrEqual(1);
    expect(prepared.terminals.sessions).toBeGreaterThanOrEqual(1);
    const restored = new pg.Client({
      connectionString: (() => {
        const url = new URL(config.DATABASE_URL);
        url.pathname = `/${prepared.database}`;
        return url.toString();
      })(),
    });
    await restored.connect();
    try {
      const status = async (id: string) =>
        (
          await restored.query<{ status: string }>(
            'SELECT status FROM devices WHERE id = $1',
            [id],
          )
        ).rows[0]?.status;
      expect(await status(blocked.id)).toBe('REVOKED');
      expect(await status(approved.id)).toBe('ACTIVE');
      expect(await status(removed.id)).toBe('REVOKED');
      expect(await status(added.id)).toBe('ACTIVE');
      // Nothing is approved by a restore.
      expect(await status(pendingNew.id)).toBe('PENDING');
    } finally {
      await restored.end();
    }
    // The live database is untouched.
    expect(
      (await ctx.db.device.findUniqueOrThrow({ where: { id: approved.id } }))
        .status,
    ).toBe('ACTIVE');
  }, 240_000);
});
