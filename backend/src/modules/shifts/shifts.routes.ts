import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

const amount = z.number().int().min(0).max(1_000_000_000);

/** Register identity: a registered device, or the signed-in user on a plain browser. */
export const registerKey = (auth: AuthContext) =>
  auth.deviceId ?? `user:${auth.userId}`;

export async function findOpenShift(
  db: Db | Tx,
  auth: AuthContext,
  branchId: string,
) {
  return db.cashShift.findFirst({
    where: {
      tenantId: auth.tenantId,
      branchId,
      registerKey: registerKey(auth),
      status: 'OPEN',
    },
  });
}

/** Totals for a shift; expected cash = opening + cash sales − cash refunds + movements. */
export async function shiftSummary(db: Db | Tx, shiftId: string) {
  const shift = await db.cashShift.findUniqueOrThrow({
    where: { id: shiftId },
  });
  const [payments, refunds, movements, orders] = await Promise.all([
    db.payment.groupBy({
      by: ['method'],
      where: { shiftId },
      _sum: { amount: true },
      _count: true,
    }),
    db.refund.groupBy({
      by: ['method'],
      where: { shiftId },
      _sum: { amount: true },
      _count: true,
    }),
    db.cashMovement.findMany({
      where: { shiftId },
      orderBy: { createdAt: 'asc' },
    }),
    db.payment.findMany({
      where: { shiftId },
      distinct: ['orderId'],
      select: { orderId: true },
    }),
  ]);
  const byMethod = (rows: typeof payments, method: string) =>
    rows.find((row) => row.method === method)?._sum.amount ?? 0;
  const movementTotal = movements.reduce(
    (sum, movement) => sum + movement.amount,
    0,
  );
  const expectedCash =
    shift.openingCash +
    byMethod(payments, 'CASH') -
    byMethod(refunds, 'CASH') +
    movementTotal;
  return {
    shift: {
      id: shift.id,
      branchId: shift.branchId,
      status: shift.status,
      openedAt: shift.openedAt,
      openedById: shift.openedById,
      closedAt: shift.closedAt,
      closedById: shift.closedById,
      openingCash: shift.openingCash,
      countedCash: shift.countedCash,
      variance: shift.variance,
      closeNote: shift.closeNote,
    },
    payments: payments.map((row) => ({
      method: row.method,
      amount: row._sum.amount ?? 0,
      count: row._count,
    })),
    refunds: refunds.map((row) => ({
      method: row.method,
      amount: row._sum.amount ?? 0,
      count: row._count,
    })),
    movements: movements.map((movement) => ({
      id: movement.id,
      amount: movement.amount,
      reason: movement.reason,
      createdAt: movement.createdAt,
    })),
    ordersPaid: orders.length,
    totalPayments: payments.reduce(
      (sum, row) => sum + (row._sum.amount ?? 0),
      0,
    ),
    totalRefunds: refunds.reduce((sum, row) => sum + (row._sum.amount ?? 0), 0),
    expectedCash:
      shift.status === 'CLOSED'
        ? (shift.expectedCash ?? expectedCash)
        : expectedCash,
  };
}

export function shiftsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('shifts.manage')];
  const now = () => services.now?.() ?? new Date();

  router.get('/shifts/current', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const shift = await findOpenShift(db, auth, branch.id);
    res.json({ shift: shift ? await shiftSummary(db, shift.id) : null });
  });

  router.post('/shifts/open', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({ branchId: z.uuid().optional(), openingCash: amount }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    try {
      const shift = await db.$transaction(async (tx) => {
        const created = await tx.cashShift.create({
          data: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            registerKey: registerKey(auth),
            deviceId: auth.deviceId,
            openedById: auth.userId,
            openingCash: input.openingCash,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: branch.id,
          actorUserId: auth.userId,
          action: 'shift.open',
          entityType: 'shift',
          entityId: created.id,
          data: { openingCash: input.openingCash },
        });
        return created;
      });
      res.status(201).json({ id: shift.id });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError(409, 'SHIFT_ALREADY_OPEN', 'shiftAlreadyOpen');
      throw error;
    }
  });

  // Pay-in (positive) or pay-out (negative) cash movement with a mandatory reason.
  router.post('/shifts/current/movements', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        amount: z
          .number()
          .int()
          .min(-1_000_000_000)
          .max(1_000_000_000)
          .refine((value) => value !== 0),
        reason: z.string().trim().min(3).max(200),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    await db.$transaction(async (tx) => {
      const shift = await findOpenShift(tx, auth, branch.id);
      if (!shift) throw new AppError(409, 'SHIFT_REQUIRED', 'shiftRequired');
      const movement = await tx.cashMovement.create({
        data: {
          tenantId: auth.tenantId,
          shiftId: shift.id,
          amount: input.amount,
          reason: input.reason,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'shift.cash_movement',
        entityType: 'shift',
        entityId: shift.id,
        data: {
          movementId: movement.id,
          amount: input.amount,
          reason: input.reason,
        },
      });
    });
    res.status(201).json({ ok: true });
  });

  router.post('/shifts/:id/close', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        countedCash: amount,
        note: z.string().trim().max(500).nullable().optional(),
      }),
      req.body,
    );
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_shifts WHERE id = ${id}::uuid FOR UPDATE`;
      const shift = await tx.cashShift.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!shift) throw errors.notFound();
      await resolveBranch(tx, auth, shift.branchId);
      // Only the register's own session or a finance manager may close a shift.
      if (
        shift.registerKey !== registerKey(auth) &&
        !auth.permissions.has('finance.view')
      )
        throw errors.forbidden();
      if (shift.status !== 'OPEN')
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      const summary = await shiftSummary(tx, id);
      const variance = input.countedCash - summary.expectedCash;
      await tx.cashShift.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt: now(),
          closedById: auth.userId,
          expectedCash: summary.expectedCash,
          countedCash: input.countedCash,
          variance,
          closeNote: input.note ?? null,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: shift.branchId,
        actorUserId: auth.userId,
        action: 'shift.close',
        entityType: 'shift',
        entityId: id,
        data: {
          expectedCash: summary.expectedCash,
          countedCash: input.countedCash,
          variance,
        },
      });
      return { expectedCash: summary.expectedCash, variance };
    });
    res.json(result);
  });

  router.get('/shifts', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('shifts.manage') &&
      !auth.permissions.has('reports.view')
    )
      throw errors.forbidden();
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    // Cashiers see their own register; report viewers see the branch.
    const shifts = await db.cashShift.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        ...(auth.permissions.has('reports.view')
          ? {}
          : { openedById: auth.userId }),
      },
      orderBy: { openedAt: 'desc' },
      take: 50,
    });
    const users = await db.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              shifts.flatMap((shift) => [
                shift.openedById,
                shift.closedById ?? shift.openedById,
              ]),
            ),
          ],
        },
      },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    res.json({
      shifts: shifts.map((shift) => ({
        id: shift.id,
        status: shift.status,
        openedAt: shift.openedAt,
        closedAt: shift.closedAt,
        openedBy: names.get(shift.openedById) ?? null,
        openingCash: shift.openingCash,
        expectedCash: shift.expectedCash,
        countedCash: shift.countedCash,
        variance: shift.variance,
      })),
    });
  });

  // Z-report data for printing at shift close.
  router.get('/shifts/:id/report', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const shift = await db.cashShift.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!shift) throw errors.notFound();
    await resolveBranch(db, auth, shift.branchId);
    const own =
      shift.openedById === auth.userId && auth.permissions.has('shifts.manage');
    if (!own && !auth.permissions.has('reports.view')) throw errors.forbidden();
    const [summary, branch, tenant, users] = await Promise.all([
      shiftSummary(db, id),
      db.branch.findUniqueOrThrow({ where: { id: shift.branchId } }),
      db.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        include: { profile: true },
      }),
      db.user.findMany({
        where: {
          id: { in: [shift.openedById, shift.closedById ?? shift.openedById] },
        },
        select: { id: true, displayName: true },
      }),
    ]);
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    res.json({
      ...summary,
      business: {
        name: tenant.name,
        legalName: tenant.profile?.legalName ?? null,
        taxId: tenant.profile?.taxId ?? null,
      },
      branch: { name: branch.name, address: branch.address },
      openedBy: names.get(shift.openedById) ?? null,
      closedBy: shift.closedById ? (names.get(shift.closedById) ?? null) : null,
    });
  });

  return router;
}
