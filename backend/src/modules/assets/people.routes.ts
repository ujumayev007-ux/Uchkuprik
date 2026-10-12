import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  canAccessBranch,
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';

const DAY = 86_400_000;
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

/** Training/certification and generic approval endpoints. */
export function peopleRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const training = [requireAuth(), requirePermission('training.manage')];

  // ---------------------------------------------------------------- courses

  router.get('/training/courses', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const courses = await db.course.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(auth.permissions.has('training.manage') ? {} : { isActive: true }),
      },
      orderBy: { title: 'asc' },
    });
    res.json({ courses });
  });

  const courseInput = z.object({
    title: z.string().trim().min(2).max(160),
    description: text(2000),
    content: text(20_000),
    validityDays: z.number().int().min(1).max(3650).nullable().optional(),
    isActive: z.boolean().default(true),
  });

  router.post('/training/courses', ...training, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(courseInput, req.body);
    try {
      const course = await db.course.create({
        data: {
          tenantId: auth.tenantId,
          ...input,
          validityDays: input.validityDays ?? null,
        },
      });
      res.status(201).json({ id: course.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.put('/training/courses/:id', ...training, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(courseInput, req.body);
    try {
      const result = await db.course.updateMany({
        where: { id, tenantId: auth.tenantId },
        data: { ...input, validityDays: input.validityDays ?? null },
      });
      if (result.count === 0) throw errors.notFound();
      res.json({ ok: true });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // ---------------------------------------------------------------- records

  router.post('/training/records', ...training, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        courseId: z.uuid(),
        userId: z.uuid(),
        completedAt: z.coerce.date(),
        score: z.number().int().min(0).max(100).nullable().optional(),
        evidenceId: z.uuid().nullable().optional(),
        note: text(500),
      }),
      req.body,
    );
    if (input.completedAt.getTime() > now().getTime() + 5 * 60_000)
      throw errors.validation([{ path: 'completedAt' }]);
    const [course, user, evidence] = await Promise.all([
      db.course.findFirst({
        where: { id: input.courseId, tenantId: auth.tenantId },
      }),
      db.user.findFirst({
        where: { id: input.userId, tenantId: auth.tenantId, deletedAt: null },
      }),
      input.evidenceId
        ? db.evidenceFile.findFirst({
            where: { id: input.evidenceId, tenantId: auth.tenantId },
            select: { id: true },
          })
        : Promise.resolve(true),
    ]);
    if (!course) throw errors.validation([{ path: 'courseId' }]);
    if (!user) throw errors.validation([{ path: 'userId' }]);
    if (!evidence) throw errors.validation([{ path: 'evidenceId' }]);
    const record = await db.$transaction(async (tx) => {
      const created = await tx.trainingRecord.create({
        data: {
          tenantId: auth.tenantId,
          courseId: course.id,
          userId: user.id,
          completedAt: input.completedAt,
          expiresAt: course.validityDays
            ? new Date(input.completedAt.getTime() + course.validityDays * DAY)
            : null,
          score: input.score ?? null,
          evidenceId: input.evidenceId ?? null,
          note: input.note,
          recordedById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'training.record.create',
        entityType: 'training_record',
        entityId: created.id,
        data: { courseId: course.id, userId: user.id },
      });
      return created;
    });
    res.status(201).json({ id: record.id, expiresAt: record.expiresAt });
  });

  /**
   * Certification matrix: for every active staff member and active course, the
   * latest record and whether it is valid, expiring within `days`, expired or missing.
   */
  router.get('/training/matrix', ...training, async (req, res) => {
    const auth = getAuth(res);
    const { days } = parse(
      z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      req.query,
    );
    const [users, courses, records] = await Promise.all([
      db.user.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null, status: 'ACTIVE' },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true },
      }),
      db.course.findMany({
        where: { tenantId: auth.tenantId, isActive: true },
        orderBy: { title: 'asc' },
        select: { id: true, title: true, validityDays: true },
      }),
      db.trainingRecord.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { completedAt: 'desc' },
      }),
    ]);
    const soon = now().getTime() + days * DAY;
    const status = (expiresAt: Date | null) =>
      expiresAt === null
        ? 'VALID'
        : expiresAt.getTime() < now().getTime()
          ? 'EXPIRED'
          : expiresAt.getTime() <= soon
            ? 'EXPIRING'
            : 'VALID';
    const cells = users.map((user) => ({
      userId: user.id,
      name: user.displayName,
      courses: courses.map((course) => {
        const latest = records.find(
          (record) =>
            record.userId === user.id && record.courseId === course.id,
        );
        return {
          courseId: course.id,
          completedAt: latest?.completedAt ?? null,
          expiresAt: latest?.expiresAt ?? null,
          status: latest ? status(latest.expiresAt) : 'MISSING',
        };
      }),
    }));
    const reminders = cells.flatMap((row) =>
      row.courses
        .filter(
          (cell) => cell.status === 'EXPIRING' || cell.status === 'EXPIRED',
        )
        .map((cell) => ({
          userId: row.userId,
          name: row.name,
          courseId: cell.courseId,
          course: courses.find((course) => course.id === cell.courseId)!.title,
          expiresAt: cell.expiresAt,
          status: cell.status,
        })),
    );
    res.json({ courses, users: cells, reminders });
  });

  // Staff view their own certificates and recertification reminders.
  router.get('/training/me', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const records = await db.trainingRecord.findMany({
      where: { tenantId: auth.tenantId, userId: auth.userId },
      orderBy: { completedAt: 'desc' },
      include: { course: { select: { title: true } } },
    });
    res.json({ records, now: now() });
  });

  // -------------------------------------------------------------- approvals

  router.get(
    '/approvals',
    requireAuth(),
    requirePermission('approvals.decide'),
    async (req, res) => {
      const auth = getAuth(res);
      const { status } = parse(
        z.object({
          status: z
            .enum(['PENDING', 'APPROVED', 'REJECTED'])
            .default('PENDING'),
        }),
        req.query,
      );
      const approvals = await db.approvalRequest.findMany({
        where: {
          tenantId: auth.tenantId,
          status,
          ...(auth.allBranches
            ? {}
            : {
                OR: [{ branchId: null }, { branchId: { in: auth.branchIds } }],
              }),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      res.json({ approvals });
    },
  );

  router.post(
    '/approvals/:id/decide',
    requireAuth(),
    requirePermission('approvals.decide'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          decision: z.enum(['APPROVED', 'REJECTED']),
          comment: text(500),
        }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const approval = await tx.approvalRequest.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (
          !approval ||
          (approval.branchId && !canAccessBranch(auth, approval.branchId))
        )
          throw errors.notFound();
        if (approval.status !== 'PENDING') throw errors.conflict();
        if (approval.requestedById === auth.userId)
          throw new AppError(409, 'SELF_APPROVAL', 'selfApproval');
        await tx.approvalRequest.update({
          where: { id },
          data: {
            status: input.decision,
            decidedById: auth.userId,
            decidedAt: now(),
            comment: input.comment,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: approval.branchId,
          actorUserId: auth.userId,
          action: `approval.${input.decision.toLowerCase()}`,
          entityType: 'approval_request',
          entityId: id,
          data: { type: approval.type, amount: approval.amount },
        });
      });
      res.json({ ok: true });
    },
  );

  return router;
}
