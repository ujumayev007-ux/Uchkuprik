import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  canAccessBranch,
  getAuth,
  requireAuth,
  requirePermission,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { businessDate } from '../orders/engine.js';

const DAY = 86_400_000;
const MAX_EVIDENCE = 2 * 1024 * 1024;
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

/** Detects the image type from its first bytes; the declared type is never trusted. */
export function sniffImage(data: Buffer): string | null {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return 'image/jpeg';
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

const checklistItems = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(200),
      requiresPhoto: z.boolean().default(false),
    }),
  )
  .min(1)
  .max(100);

type RunResult = {
  label: string;
  requiresPhoto: boolean;
  done: boolean;
  note: string | null;
  evidenceId: string | null;
};

async function assertEvidence(
  tx: Tx,
  auth: AuthContext,
  ids: (string | null | undefined)[],
) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return;
  const found = await tx.evidenceFile.count({
    where: { tenantId: auth.tenantId, id: { in: wanted } },
  });
  if (found !== wanted.length)
    throw errors.validation([{ path: 'evidenceId' }]);
}

export function operationsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [requireAuth(), requirePermission('operations.manage')];
  // Managers can do everything front-line staff can.
  const performOrManage = [
    requireAuth(),
    (_req: unknown, res: import('express').Response, next: () => void) => {
      const auth = getAuth(res);
      if (
        auth.tenantKind !== 'BUSINESS' ||
        !(
          auth.permissions.has('operations.perform') ||
          auth.permissions.has('operations.manage')
        )
      )
        throw errors.forbidden();
      next();
    },
  ];

  // -------------------------------------------------------------- evidence

  router.post('/operations/evidence', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const data = Buffer.isBuffer(req.body) ? req.body : null;
    const type = data ? sniffImage(data) : null;
    if (!data || data.length === 0 || data.length > MAX_EVIDENCE || !type)
      throw new AppError(400, 'EVIDENCE_INVALID', 'evidenceInvalid');
    const file = await db.evidenceFile.create({
      data: {
        tenantId: auth.tenantId,
        branchId: auth.activeBranchId,
        uploadedById: auth.userId,
        contentType: type,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        data: new Uint8Array(data),
      },
      select: { id: true },
    });
    res.status(201).json({ id: file.id });
  });

  router.get(
    '/operations/evidence/:id',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const file = await db.evidenceFile.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!file || (file.branchId && !canAccessBranch(auth, file.branchId)))
        throw errors.notFound();
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(file.data));
    },
  );

  // ------------------------------------------------------------------ SOPs

  router.get('/operations/sops', ...performOrManage, async (_req, res) => {
    const auth = getAuth(res);
    const sops = await db.sopDocument.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(auth.permissions.has('operations.manage')
          ? {}
          : { isActive: true }),
      },
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });
    res.json({ sops });
  });

  router.get('/operations/sops/:id/revisions', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const revisions = await db.sopRevision.findMany({
      where: { tenantId: auth.tenantId, sopId: id },
      orderBy: { version: 'desc' },
    });
    res.json({ revisions });
  });

  const sopInput = z.object({
    title: z.string().trim().min(2).max(200),
    category: z.string().trim().min(2).max(60),
    body: z.string().trim().min(1).max(50_000),
    isActive: z.boolean().default(true),
  });

  router.post('/operations/sops', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(sopInput, req.body);
    const sop = await db.$transaction(async (tx) => {
      const created = await tx.sopDocument.create({
        data: { tenantId: auth.tenantId, ...input, updatedById: auth.userId },
      });
      await tx.sopRevision.create({
        data: {
          tenantId: auth.tenantId,
          sopId: created.id,
          version: 1,
          title: input.title,
          body: input.body,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'operations.sop.create',
        entityType: 'sop',
        entityId: created.id,
        data: { title: input.title },
      });
      return created;
    });
    res.status(201).json({ id: sop.id });
  });

  // Content changes publish a new version; the previous text stays in revisions.
  router.put('/operations/sops/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(sopInput, req.body);
    const version = await db.$transaction(async (tx) => {
      const found = await tx.sopDocument.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!found) throw errors.notFound();
      const changed = found.body !== input.body || found.title !== input.title;
      const next = changed ? found.version + 1 : found.version;
      await tx.sopDocument.update({
        where: { id },
        data: { ...input, version: next, updatedById: auth.userId },
      });
      if (changed)
        await tx.sopRevision.create({
          data: {
            tenantId: auth.tenantId,
            sopId: id,
            version: next,
            title: input.title,
            body: input.body,
            createdById: auth.userId,
          },
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'operations.sop.update',
        entityType: 'sop',
        entityId: id,
        data: { version: next, isActive: input.isActive },
      });
      return next;
    });
    res.json({ version });
  });

  // ------------------------------------------------------------ checklists

  router.get(
    '/operations/checklist-templates',
    ...performOrManage,
    async (_req, res) => {
      const auth = getAuth(res);
      const templates = await db.checklistTemplate.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      });
      res.json({ templates });
    },
  );

  const templateInput = z.object({
    name: z.string().trim().min(2).max(120),
    kind: z.enum(['OPENING', 'CLOSING', 'CLEANING', 'HACCP', 'OTHER']),
    branchId: z.uuid().nullable().optional(),
    items: checklistItems,
    isActive: z.boolean().default(true),
  });

  async function templateData(
    tx: Tx,
    auth: AuthContext,
    input: z.infer<typeof templateInput>,
  ) {
    if (input.branchId) {
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, tenantId: auth.tenantId, deletedAt: null },
      });
      if (!branch) throw errors.validation([{ path: 'branchId' }]);
    }
    return { ...input, branchId: input.branchId ?? null };
  }

  router.post(
    '/operations/checklist-templates',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(templateInput, req.body);
      const template = await db.$transaction(async (tx) => {
        const created = await tx.checklistTemplate.create({
          data: {
            tenantId: auth.tenantId,
            ...(await templateData(tx, auth, input)),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'operations.checklist.template.create',
          entityType: 'checklist_template',
          entityId: created.id,
          data: { name: input.name, kind: input.kind },
        });
        return created;
      });
      res.status(201).json({ id: template.id });
    },
  );

  router.put(
    '/operations/checklist-templates/:id',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(templateInput, req.body);
      await db.$transaction(async (tx) => {
        const found = await tx.checklistTemplate.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!found) throw errors.notFound();
        await tx.checklistTemplate.update({
          where: { id },
          data: await templateData(tx, auth, input),
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'operations.checklist.template.update',
          entityType: 'checklist_template',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  // Today's checklists for the branch: templates with their run, if started.
  router.get('/operations/checklists', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const date = query.date
      ? new Date(`${query.date}T00:00:00.000Z`)
      : businessDate(now(), branch.timezone);
    const [templates, runs] = await Promise.all([
      db.checklistTemplate.findMany({
        where: {
          tenantId: auth.tenantId,
          isActive: true,
          OR: [{ branchId: null }, { branchId: branch.id }],
        },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      }),
      db.checklistRun.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          businessDate: date,
        },
      }),
    ]);
    res.json({
      branchId: branch.id,
      date: date.toISOString().slice(0, 10),
      checklists: templates.map((template) => ({
        template,
        run: runs.find((run) => run.templateId === template.id) ?? null,
      })),
    });
  });

  router.post(
    '/operations/checklists/:templateId/start',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const templateId = parse(z.uuid(), req.params.templateId);
      const { branchId } = parse(
        z.object({ branchId: z.uuid().optional() }),
        req.body,
      );
      const branch = await resolveBranch(db, auth, branchId);
      const template = await db.checklistTemplate.findFirst({
        where: {
          id: templateId,
          tenantId: auth.tenantId,
          isActive: true,
          OR: [{ branchId: null }, { branchId: branch.id }],
        },
      });
      if (!template) throw errors.notFound();
      const date = businessDate(now(), branch.timezone);
      const items = template.items as {
        label: string;
        requiresPhoto: boolean;
      }[];
      const run = await db.checklistRun.upsert({
        where: {
          templateId_branchId_businessDate: {
            templateId,
            branchId: branch.id,
            businessDate: date,
          },
        },
        update: {},
        create: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          templateId,
          businessDate: date,
          startedById: auth.userId,
          results: items.map((item): RunResult => ({
            label: item.label,
            requiresPhoto: item.requiresPhoto,
            done: false,
            note: null,
            evidenceId: null,
          })),
        },
      });
      res.status(201).json({ run });
    },
  );

  async function loadRun(tx: Tx, auth: AuthContext, id: string) {
    const run = await tx.checklistRun.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!run || !canAccessBranch(auth, run.branchId)) throw errors.notFound();
    return run;
  }

  router.patch(
    '/operations/checklist-runs/:id/items/:index',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const index = parse(
        z.coerce.number().int().min(0).max(99),
        req.params.index,
      );
      const input = parse(
        z.object({
          done: z.boolean(),
          note: text(300),
          evidenceId: z.uuid().nullable().optional(),
        }),
        req.body,
      );
      const run = await db.$transaction(async (tx) => {
        const found = await loadRun(tx, auth, id);
        if (found.status !== 'IN_PROGRESS')
          throw new AppError(409, 'CHECKLIST_CLOSED', 'checklistClosed');
        const results = found.results as RunResult[];
        const item = results[index];
        if (!item) throw errors.notFound();
        await assertEvidence(tx, auth, [input.evidenceId]);
        results[index] = {
          ...item,
          done: input.done,
          note: input.note,
          evidenceId: input.evidenceId ?? item.evidenceId,
        };
        return tx.checklistRun.update({ where: { id }, data: { results } });
      });
      res.json({ run });
    },
  );

  router.post(
    '/operations/checklist-runs/:id/complete',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const run = await loadRun(tx, auth, id);
        if (run.status !== 'IN_PROGRESS')
          throw new AppError(409, 'CHECKLIST_CLOSED', 'checklistClosed');
        const results = run.results as RunResult[];
        const missing = results
          .map((item, index) => ({ item, index }))
          .filter(
            ({ item }) =>
              !item.done || (item.requiresPhoto && !item.evidenceId),
          )
          .map(({ index }) => index);
        if (missing.length > 0)
          throw new AppError(
            409,
            'CHECKLIST_INCOMPLETE',
            'checklistIncomplete',
            {
              items: missing,
            },
          );
        await tx.checklistRun.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            completedById: auth.userId,
            completedAt: now(),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: run.branchId,
          actorUserId: auth.userId,
          action: 'operations.checklist.complete',
          entityType: 'checklist_run',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  // Manager sign-off; the approver must differ from the person who completed it.
  router.post(
    '/operations/checklist-runs/:id/approve',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const run = await loadRun(tx, auth, id);
        if (run.status !== 'COMPLETED') throw errors.conflict();
        if (run.completedById === auth.userId)
          throw new AppError(409, 'SELF_APPROVAL', 'selfApproval');
        await tx.checklistRun.update({
          where: { id },
          data: {
            status: 'APPROVED',
            approvedById: auth.userId,
            approvedAt: now(),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: run.branchId,
          actorUserId: auth.userId,
          action: 'operations.checklist.approve',
          entityType: 'checklist_run',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  // ---------------------------------------------------------- temperatures

  router.get(
    '/operations/temperatures',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          days: z.coerce.number().int().min(1).max(90).default(7),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const logs = await db.temperatureLog.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          recordedAt: { gte: new Date(now().getTime() - query.days * DAY) },
        },
        orderBy: { recordedAt: 'desc' },
        take: 500,
      });
      res.json({ logs });
    },
  );

  // An out-of-range reading automatically opens a food-safety incident.
  router.post(
    '/operations/temperatures',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z
          .object({
            branchId: z.uuid().optional(),
            point: z.string().trim().min(2).max(80),
            value: z.number().min(-100).max(400),
            minValue: z.number().min(-100).max(400),
            maxValue: z.number().min(-100).max(400),
            note: text(300),
          })
          .refine((value) => value.minValue <= value.maxValue, {
            path: ['maxValue'],
          }),
        req.body,
      );
      const branch = await resolveBranch(db, auth, input.branchId);
      const outOfRange =
        input.value < input.minValue || input.value > input.maxValue;
      const result = await db.$transaction(async (tx) => {
        let incidentId: string | null = null;
        if (outOfRange) {
          const incident = await tx.incident.create({
            data: {
              tenantId: auth.tenantId,
              branchId: branch.id,
              type: 'FOOD_SAFETY',
              severity: 'HIGH',
              title: `Harorat me’yordan tashqarida: ${input.point}`,
              description: `${input.value} °C (me’yor ${input.minValue}…${input.maxValue} °C).${input.note ? ` ${input.note}` : ''}`,
              reportedById: auth.userId,
            },
          });
          incidentId = incident.id;
        }
        const log = await tx.temperatureLog.create({
          data: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            point: input.point,
            value: new Prisma.Decimal(input.value),
            minValue: new Prisma.Decimal(input.minValue),
            maxValue: new Prisma.Decimal(input.maxValue),
            outOfRange,
            note: input.note,
            recordedById: auth.userId,
            recordedAt: now(),
            incidentId,
          },
        });
        return { id: log.id, outOfRange, incidentId };
      });
      res.status(201).json(result);
    },
  );

  // ------------------------------------------------------------- incidents

  router.get('/operations/incidents', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        status: z
          .enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'])
          .optional(),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const incidents = await db.incident.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ incidents });
  });

  router.post('/operations/incidents', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        type: z.enum([
          'FOOD_SAFETY',
          'EQUIPMENT',
          'INJURY',
          'CUSTOMER',
          'SECURITY',
          'OTHER',
        ]),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        title: z.string().trim().min(3).max(200),
        description: z.string().trim().min(3).max(4000),
        evidenceIds: z.array(z.uuid()).max(10).default([]),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const incident = await db.$transaction(async (tx) => {
      await assertEvidence(tx, auth, input.evidenceIds);
      const created = await tx.incident.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          type: input.type,
          severity: input.severity,
          title: input.title,
          description: input.description,
          evidenceIds: input.evidenceIds,
          reportedById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'operations.incident.create',
        entityType: 'incident',
        entityId: created.id,
        data: { type: input.type, severity: input.severity },
      });
      return created;
    });
    res.status(201).json({ id: incident.id });
  });

  // Investigation and corrective/preventive actions (CAPA). Closing is a manager approval.
  router.patch('/operations/incidents/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        status: z.enum(['INVESTIGATING', 'RESOLVED', 'CLOSED']),
        rootCause: text(2000),
        correctiveAction: text(2000),
        preventiveAction: text(2000),
      }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const incident = await tx.incident.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!incident || !canAccessBranch(auth, incident.branchId))
        throw errors.notFound();
      if (incident.status === 'CLOSED') throw errors.conflict();
      const merged = {
        rootCause: input.rootCause ?? incident.rootCause,
        correctiveAction: input.correctiveAction ?? incident.correctiveAction,
        preventiveAction: input.preventiveAction ?? incident.preventiveAction,
      };
      if (
        (input.status === 'RESOLVED' || input.status === 'CLOSED') &&
        (!merged.rootCause || !merged.correctiveAction)
      )
        throw new AppError(409, 'CAPA_REQUIRED', 'capaRequired');
      if (input.status === 'CLOSED' && incident.status !== 'RESOLVED')
        throw new AppError(409, 'INCIDENT_NOT_RESOLVED', 'incidentNotResolved');
      await tx.incident.update({
        where: { id },
        data: {
          ...merged,
          status: input.status,
          ...(input.status === 'RESOLVED'
            ? { resolvedById: auth.userId, resolvedAt: now() }
            : {}),
          ...(input.status === 'CLOSED'
            ? { closedById: auth.userId, closedAt: now() }
            : {}),
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: incident.branchId,
        actorUserId: auth.userId,
        action: `operations.incident.${input.status.toLowerCase()}`,
        entityType: 'incident',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- handovers

  router.get('/operations/handovers', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const handovers = await db.shiftHandover.findMany({
      where: { tenantId: auth.tenantId, branchId: branch.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const userIds = [
      ...new Set(
        handovers.flatMap((h) =>
          [h.fromUserId, h.acknowledgedById].filter(Boolean),
        ),
      ),
    ] as string[];
    const users = await db.user.findMany({
      where: { tenantId: auth.tenantId, id: { in: userIds } },
      select: { id: true, displayName: true },
    });
    const name = (id: string | null) =>
      users.find((user) => user.id === id)?.displayName ?? null;
    res.json({
      handovers: handovers.map((h) => ({
        ...h,
        fromName: name(h.fromUserId),
        acknowledgedByName: name(h.acknowledgedById),
      })),
    });
  });

  router.post('/operations/handovers', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        notes: z.string().trim().min(3).max(4000),
        openIssues: text(2000),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const handover = await db.shiftHandover.create({
      data: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        fromUserId: auth.userId,
        notes: input.notes,
        openIssues: input.openIssues,
      },
    });
    res.status(201).json({ id: handover.id });
  });

  // The incoming person confirms they read it; nobody acknowledges their own handover.
  router.post(
    '/operations/handovers/:id/acknowledge',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const handover = await db.shiftHandover.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!handover || !canAccessBranch(auth, handover.branchId))
        throw errors.notFound();
      if (handover.fromUserId === auth.userId)
        throw new AppError(409, 'SELF_APPROVAL', 'selfApproval');
      const result = await db.shiftHandover.updateMany({
        where: { id, acknowledgedAt: null },
        data: { acknowledgedById: auth.userId, acknowledgedAt: now() },
      });
      if (result.count === 0) throw errors.conflict();
      res.json({ ok: true });
    },
  );

  // ----------------------------------------------------------------- tasks

  router.get('/operations/tasks', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        status: z.enum(['OPEN', 'DONE', 'CANCELLED']).default('OPEN'),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const tasks = await db.opsTask.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        status: query.status,
        // Staff see their own and unassigned tasks; managers see all.
        ...(auth.permissions.has('operations.manage')
          ? {}
          : { OR: [{ assigneeId: null }, { assigneeId: auth.userId }] }),
      },
      orderBy: { dueAt: query.status === 'OPEN' ? 'asc' : 'desc' },
      take: 200,
    });
    res.json({ tasks, now: now() });
  });

  router.post('/operations/tasks', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        title: z.string().trim().min(2).max(200),
        description: text(2000),
        assigneeId: z.uuid().nullable().optional(),
        dueAt: z.coerce.date(),
        recurrence: z.enum(['NONE', 'DAILY', 'WEEKLY']).default('NONE'),
        requiresPhoto: z.boolean().default(false),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    if (input.assigneeId) {
      const assignee = await db.user.findFirst({
        where: {
          id: input.assigneeId,
          tenantId: auth.tenantId,
          deletedAt: null,
          OR: [
            { allBranches: true },
            { branches: { some: { branchId: branch.id } } },
          ],
        },
      });
      if (!assignee) throw errors.validation([{ path: 'assigneeId' }]);
    }
    const task = await db.opsTask.create({
      data: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        title: input.title,
        description: input.description,
        assigneeId: input.assigneeId ?? null,
        dueAt: input.dueAt,
        recurrence: input.recurrence,
        requiresPhoto: input.requiresPhoto,
        createdById: auth.userId,
      },
    });
    res.status(201).json({ id: task.id });
  });

  // Completing a recurring task schedules the next occurrence.
  router.post(
    '/operations/tasks/:id/complete',
    ...performOrManage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          note: text(500),
          evidenceId: z.uuid().nullable().optional(),
        }),
        req.body,
      );
      const next = await db.$transaction(async (tx) => {
        const task = await tx.opsTask.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!task || !canAccessBranch(auth, task.branchId))
          throw errors.notFound();
        if (
          task.assigneeId &&
          task.assigneeId !== auth.userId &&
          !auth.permissions.has('operations.manage')
        )
          throw errors.forbidden();
        if (task.requiresPhoto && !input.evidenceId)
          throw new AppError(409, 'PHOTO_REQUIRED', 'photoRequired');
        await assertEvidence(tx, auth, [input.evidenceId]);
        const result = await tx.opsTask.updateMany({
          where: { id, status: 'OPEN' },
          data: {
            status: 'DONE',
            completedById: auth.userId,
            completedAt: now(),
            note: input.note,
            evidenceId: input.evidenceId ?? null,
          },
        });
        if (result.count === 0) throw errors.conflict();
        if (task.recurrence === 'NONE') return null;
        const step = task.recurrence === 'DAILY' ? DAY : 7 * DAY;
        let dueAt = task.dueAt.getTime() + step;
        while (dueAt <= now().getTime()) dueAt += step;
        const created = await tx.opsTask.create({
          data: {
            tenantId: task.tenantId,
            branchId: task.branchId,
            title: task.title,
            description: task.description,
            assigneeId: task.assigneeId,
            dueAt: new Date(dueAt),
            recurrence: task.recurrence,
            requiresPhoto: task.requiresPhoto,
            createdById: task.createdById,
          },
        });
        return created.id;
      });
      res.json({ ok: true, nextTaskId: next });
    },
  );

  // --------------------------------------------------------------- batches

  router.get('/operations/batches', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        status: z
          .enum(['ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED'])
          .optional(),
        lot: z.string().trim().max(60).optional(),
      }),
      req.query,
    );
    // Recall searches span every branch the user can access.
    const batches = await db.stockBatch.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(auth.allBranches ? {} : { branchId: { in: auth.branchIds } }),
        ...(query.status ? { status: query.status } : {}),
        ...(query.lot
          ? { lotNumber: { contains: query.lot, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'desc' }],
      take: 300,
      include: {
        stockItem: { select: { name: true, baseUnit: true } },
        branch: { select: { name: true } },
      },
    });
    res.json({ batches });
  });

  router.post('/operations/batches', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        stockItemId: z.uuid(),
        supplierId: z.uuid().nullable().optional(),
        lotNumber: z.string().trim().min(1).max(60),
        expiresAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        quantity: z.number().positive().max(1_000_000),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const [item, supplier] = await Promise.all([
      db.stockItem.findFirst({
        where: { id: input.stockItemId, tenantId: auth.tenantId },
      }),
      input.supplierId
        ? db.supplier.findFirst({
            where: { id: input.supplierId, tenantId: auth.tenantId },
          })
        : Promise.resolve(true),
    ]);
    if (!item) throw errors.validation([{ path: 'stockItemId' }]);
    if (!supplier) throw errors.validation([{ path: 'supplierId' }]);
    const batch = await db.stockBatch.create({
      data: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        stockItemId: item.id,
        supplierId: input.supplierId ?? null,
        lotNumber: input.lotNumber,
        expiresAt: input.expiresAt
          ? new Date(`${input.expiresAt}T00:00:00.000Z`)
          : null,
        quantity: new Prisma.Decimal(input.quantity),
        receivedAt: now(),
        createdById: auth.userId,
      },
    });
    res.status(201).json({ id: batch.id });
  });

  // Quarantine, recall, release or disposal. Disposal and recall are final.
  router.post('/operations/batches/:id/status', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        status: z.enum(['ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED']),
        reason: z.string().trim().min(3).max(500),
      }),
      req.body,
    );
    const allowed: Record<string, string[]> = {
      ACTIVE: ['QUARANTINED', 'RECALLED', 'DISPOSED'],
      QUARANTINED: ['ACTIVE', 'RECALLED', 'DISPOSED'],
      RECALLED: ['DISPOSED'],
      DISPOSED: [],
    };
    await db.$transaction(async (tx) => {
      const batch = await tx.stockBatch.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!batch || !canAccessBranch(auth, batch.branchId))
        throw errors.notFound();
      if (!allowed[batch.status]!.includes(input.status))
        throw new AppError(409, 'BATCH_STATUS_INVALID', 'batchStatusInvalid');
      await tx.stockBatch.update({
        where: { id },
        data: {
          status: input.status,
          statusReason: input.reason,
          statusChangedById: auth.userId,
          statusChangedAt: now(),
        },
      });
      // A recall of a lot applies to every branch that received the same lot.
      if (input.status === 'RECALLED')
        await tx.stockBatch.updateMany({
          where: {
            tenantId: auth.tenantId,
            stockItemId: batch.stockItemId,
            lotNumber: batch.lotNumber,
            status: { in: ['ACTIVE', 'QUARANTINED'] },
          },
          data: {
            status: 'RECALLED',
            statusReason: input.reason,
            statusChangedById: auth.userId,
            statusChangedAt: now(),
          },
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: batch.branchId,
        actorUserId: auth.userId,
        action: `operations.batch.${input.status.toLowerCase()}`,
        entityType: 'stock_batch',
        entityId: id,
        data: { lotNumber: batch.lotNumber, reason: input.reason },
      });
    });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- allergens

  router.get('/operations/allergens', ...performOrManage, async (_req, res) => {
    const auth = getAuth(res);
    const products = await db.product.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, allergens: true },
    });
    const allergens = [...new Set(products.flatMap((p) => p.allergens))].sort();
    res.json({ allergens, products });
  });

  // --------------------------------------------------------------- summary

  router.get('/operations/summary', ...performOrManage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const date = businessDate(now(), branch.timezone);
    const soon = new Date(now().getTime() + 3 * DAY);
    const [templates, runs, openIncidents, overdueTasks, alarms, expiring] =
      await Promise.all([
        db.checklistTemplate.count({
          where: {
            tenantId: auth.tenantId,
            isActive: true,
            OR: [{ branchId: null }, { branchId: branch.id }],
          },
        }),
        db.checklistRun.groupBy({
          by: ['status'],
          where: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            businessDate: date,
          },
          _count: true,
        }),
        db.incident.count({
          where: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            status: { in: ['OPEN', 'INVESTIGATING'] },
          },
        }),
        db.opsTask.count({
          where: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            status: 'OPEN',
            dueAt: { lt: now() },
          },
        }),
        db.temperatureLog.count({
          where: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            outOfRange: true,
            recordedAt: { gte: new Date(now().getTime() - DAY) },
          },
        }),
        db.stockBatch.count({
          where: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            status: 'ACTIVE',
            expiresAt: { lte: soon },
          },
        }),
      ]);
    const done = runs
      .filter((row) => row.status !== 'IN_PROGRESS')
      .reduce((sum, row) => sum + row._count, 0);
    res.json({
      checklists: { total: templates, done },
      openIncidents,
      overdueTasks,
      temperatureAlarms24h: alarms,
      expiringBatches: expiring,
    });
  });

  return router;
}
