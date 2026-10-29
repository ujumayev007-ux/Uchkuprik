import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { PARTIAL_GROUP_KEYS } from '../../lib/backup-partial.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';

// An uploaded export is at most this large.
const MAX_UPLOAD = 2 * 1024 ** 3;
const backupName = z.string().regex(/^[0-9A-Za-z.-]{10,80}$/);
const password = z.string().min(8).max(200);
/** A restore or rollback needs the word TIKLASH typed in. */
function confirmed(body: unknown) {
  if ((body as { confirm?: unknown } | undefined)?.confirm !== 'TIKLASH')
    throw new AppError(400, 'BACKUP_CONFIRM', 'backupConfirm');
}

/**
 * Zaxira nusxalar on the restaurant computer: list, back up now, check, download
 * encrypted, upload, and restore (into a new database swapped in on restart; the
 * current database is kept and can be put back).
 */
export function backupsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('settings.manage')];
  const recent = requireRecentAuth(services);
  const store = () => {
    if (!services.backups)
      throw new AppError(409, 'BACKUP_UNAVAILABLE', 'backupUnavailable');
    return services.backups;
  };
  const record = (
    req: Parameters<typeof audit>[1],
    auth: ReturnType<typeof getAuth>,
    action: string,
    entityId: string,
    data?: object,
  ) =>
    audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action,
      entityType: 'backup',
      entityId,
      ...(data ? { data } : {}),
    });

  router.get('/backups', ...manage, async (_req, res) => {
    if (!services.backups) {
      res.json({
        available: false,
        canRestore: false,
        backups: [],
        kept: [],
        status: null,
      });
      return;
    }
    const [backups, kept, status] = await Promise.all([
      services.backups.list(),
      services.backups.keptDatabases().catch(() => []),
      services.backups.status(),
    ]);
    res.json({
      available: true,
      canRestore: services.backups.canRestore,
      backups,
      kept,
      status,
    });
  });

  // Lets the page ask for the password again before a download or an upload.
  router.post('/backups/unlock', ...manage, recent, (_req, res) => {
    store();
    res.json({ ok: true });
  });

  router.post('/backups', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const created = await store().create('manual');
    await record(req, auth, 'backup.create', created.name);
    res.status(201).json(created);
  });

  router.post('/backups/:name/verify', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const name = parse(backupName, req.params.name);
    const result = await store().verify(name);
    await record(req, auth, 'backup.verify', name, { ok: result.ok });
    res.json(result);
  });

  // The backup encrypted with a password the Admin keeps (USB stick, another computer).
  router.post('/backups/:name/export', ...manage, recent, async (req, res) => {
    const auth = getAuth(res);
    const name = parse(backupName, req.params.name);
    const input = parse(z.object({ password }), req.body);
    const backups = store();
    await record(req, auth, 'backup.export', name);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name.replace('.ndjson.gz', '')}.ffbk"`,
    );
    await backups.exportEncrypted(name, input.password, res);
  });

  // Step 1 of an import: the encrypted file as the raw request body.
  router.post('/backups/upload', ...manage, recent, async (req, res) => {
    const id = randomBytes(12).toString('hex');
    const file = await store().uploadTarget(id);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        done(
          size > MAX_UPLOAD
            ? new AppError(413, 'TOO_LARGE', 'validation')
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(file, { mode: 0o600 }));
    } catch (error) {
      await rm(file, { force: true });
      throw error instanceof AppError
        ? error
        : new AppError(400, 'BACKUP_INVALID', 'backupInvalid');
    }
    res.status(201).json({ uploadId: id, bytes: size });
  });

  // Step 2: decrypt with the password and check the backup restores.
  router.post('/backups/import', ...manage, recent, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({ uploadId: z.string().regex(/^[0-9a-f]{24}$/), password }),
      req.body,
    );
    const backups = store();
    const file = await backups.uploadTarget(input.uploadId);
    try {
      const imported = await backups.importEncrypted(file, input.password);
      await record(req, auth, 'backup.import', imported.name);
      res.status(201).json(imported);
    } finally {
      await rm(file, { force: true });
    }
  });

  router.post('/backups/:name/restore', ...manage, recent, async (req, res) => {
    const auth = getAuth(res);
    const name = parse(backupName, req.params.name);
    confirmed(req.body);
    const prepared = await store().prepareRestore(name);
    await record(req, auth, 'backup.restore', name, prepared);
    res.json({ ...prepared, restarting: true });
    services.requestRestart?.();
  });

  // Qisman tiklash: what would change (nothing is written)…
  const groupsInput = z.object({
    groups: z.array(z.enum(PARTIAL_GROUP_KEYS)).min(1).max(5),
  });
  router.post('/backups/:name/partial/preview', ...manage, async (req, res) => {
    const name = parse(backupName, req.params.name);
    const { groups } = parse(groupsInput, req.body);
    res.json(await store().partial(name, groups, { dryRun: true }));
  });

  // …and the real one (TIKLASH typed in, recent sign-in): the live database changes in
  // one transaction, after a full pre-restore backup; no restart.
  router.post('/backups/:name/partial', ...manage, recent, async (req, res) => {
    const auth = getAuth(res);
    const name = parse(backupName, req.params.name);
    const { groups } = parse(groupsInput, req.body);
    confirmed(req.body);
    const result = await store().partial(name, groups, { dryRun: false });
    await record(req, auth, 'backup.partial', name, {
      groups,
      safetyBackup: result.safetyBackup,
      tables: result.tables,
    });
    res.json(result);
  });

  router.post('/backups/rollback', ...manage, recent, async (req, res) => {
    const auth = getAuth(res);
    confirmed(req.body);
    const input = parse(z.object({ database: z.string().max(64) }), req.body);
    const prepared = await store().prepareRollback(input.database);
    await record(req, auth, 'backup.rollback', input.database);
    res.json({ ...prepared, restarting: true });
    services.requestRestart?.();
  });

  return router;
}
