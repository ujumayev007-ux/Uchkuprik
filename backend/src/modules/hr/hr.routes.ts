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
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { assertOpenPeriod, computePayroll } from './payroll.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayStart = (value: string) => new Date(`${value}T00:00:00.000Z`);

export function hrRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const hr = [requireAuth(), requirePermission('hr.manage')];
  const business = (auth: AuthContext) => {
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
  };

  // --- Employee pay profiles --------------------------------------------------

  router.get('/hr/employees', ...hr, async (_req, res) => {
    const auth = getAuth(res);
    const [users, profiles] = await Promise.all([
      db.user.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null },
        orderBy: { displayName: 'asc' },
        select: { id: true, displayName: true, status: true },
      }),
      db.employeeProfile.findMany({ where: { tenantId: auth.tenantId } }),
    ]);
    res.json({
      employees: users.map((user) => {
        const profile = profiles.find((item) => item.userId === user.id);
        return {
          userId: user.id,
          name: user.displayName,
          status: user.status,
          position: profile?.position ?? null,
          payType: profile?.payType ?? 'NONE',
          rate: profile?.rate ?? 0,
          hireDate: profile?.hireDate ?? null,
        };
      }),
    });
  });

  // Pay rates are sensitive: changes need re-authentication and are audited.
  router.put(
    '/hr/employees/:userId',
    ...hr,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const userId = parse(z.uuid(), req.params.userId);
      const input = parse(
        z.object({
          position: z.string().trim().max(60).nullable().optional(),
          payType: z.enum(['NONE', 'HOURLY', 'MONTHLY']),
          rate: z.number().int().min(0).max(1_000_000_000),
          hireDate: isoDate.nullable().optional(),
        }),
        req.body,
      );
      const user = await db.user.findFirst({
        where: { id: userId, tenantId: auth.tenantId },
      });
      if (!user) throw errors.notFound();
      const data = {
        position: input.position ?? null,
        payType: input.payType,
        rate: input.rate,
        hireDate: input.hireDate ? dayStart(input.hireDate) : null,
      };
      await db.employeeProfile.upsert({
        where: { userId },
        create: { userId, tenantId: auth.tenantId, ...data },
        update: data,
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'hr.employee.update',
        entityType: 'user',
        entityId: userId,
        data: { payType: input.payType, rate: input.rate },
      });
      res.json({ ok: true });
    },
  );

  // --- Attendance -----------------------------------------------------------------

  router.get('/attendance/me', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    business(auth);
    const records = await db.attendanceRecord.findMany({
      where: { userId: auth.userId },
      orderBy: { clockIn: 'desc' },
      take: 20,
    });
    res.json({
      open: records.find((record) => !record.clockOut) ?? null,
      records,
    });
  });

  router.post('/attendance/clock-in', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    business(auth);
    const branch = await resolveBranch(db, auth, null);
    try {
      const record = await db.attendanceRecord.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          userId: auth.userId,
          clockIn: now(),
        },
      });
      res.status(201).json({ id: record.id });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new AppError(409, 'ALREADY_CLOCKED_IN', 'alreadyClockedIn');
      throw error;
    }
  });

  router.post('/attendance/clock-out', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    business(auth);
    const result = await db.attendanceRecord.updateMany({
      where: { userId: auth.userId, tenantId: auth.tenantId, clockOut: null },
      data: { clockOut: now() },
    });
    if (result.count === 0)
      throw new AppError(409, 'NOT_CLOCKED_IN', 'notClockedIn');
    res.json({ ok: true });
  });

  router.get('/attendance', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({ branchId: z.uuid().optional(), from: isoDate, to: isoDate }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const records = await db.attendanceRecord.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        clockIn: {
          gte: dayStart(query.from),
          lt: new Date(dayStart(query.to).getTime() + 86_400_000),
        },
      },
      orderBy: { clockIn: 'desc' },
    });
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(records.map((r) => r.userId))] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    res.json({
      records: records.map((record) => ({
        ...record,
        name: names.get(record.userId) ?? '—',
        minutes: record.clockOut
          ? Math.floor(
              (record.clockOut.getTime() - record.clockIn.getTime()) / 60_000,
            )
          : null,
      })),
    });
  });

  // Corrections (forgotten clock-out, wrong time) require a reason and are audited.
  router.patch('/attendance/:id', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        clockIn: z.coerce.date(),
        clockOut: z.coerce.date().nullable(),
        note: z.string().trim().min(3).max(200),
      }),
      req.body,
    );
    if (input.clockOut && input.clockOut <= input.clockIn)
      throw errors.validation([{ path: 'clockOut' }]);
    await db.$transaction(async (tx) => {
      const record = await tx.attendanceRecord.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!record) throw errors.notFound();
      await resolveBranch(tx, auth, record.branchId);
      await assertOpenPeriod(tx, auth.tenantId, record.clockIn);
      await assertOpenPeriod(tx, auth.tenantId, input.clockIn);
      await tx.attendanceRecord.update({
        where: { id },
        data: {
          clockIn: input.clockIn,
          clockOut: input.clockOut,
          note: input.note,
          correctedById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: record.branchId,
        actorUserId: auth.userId,
        action: 'attendance.correct',
        entityType: 'attendance',
        entityId: id,
        data: {
          before: {
            clockIn: record.clockIn.toISOString(),
            clockOut: record.clockOut?.toISOString() ?? null,
          },
          note: input.note,
        },
      });
    });
    res.json({ ok: true });
  });

  // --- Shift schedule ----------------------------------------------------------------

  router.get('/schedule', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    business(auth);
    const query = parse(
      z.object({ branchId: z.uuid().optional(), from: isoDate, to: isoDate }),
      req.query,
    );
    const range = {
      gte: dayStart(query.from),
      lt: new Date(dayStart(query.to).getTime() + 86_400_000),
    };
    const manager = auth.permissions.has('hr.manage');
    const branch = manager
      ? await resolveBranch(db, auth, query.branchId)
      : null;
    const shifts = await db.scheduledShift.findMany({
      where: {
        tenantId: auth.tenantId,
        startsAt: range,
        ...(manager ? { branchId: branch!.id } : { userId: auth.userId }),
      },
      orderBy: { startsAt: 'asc' },
    });
    const users = await db.user.findMany({
      where: { id: { in: [...new Set(shifts.map((s) => s.userId))] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    res.json({
      shifts: shifts.map((shift) => ({
        ...shift,
        name: names.get(shift.userId) ?? '—',
      })),
    });
  });

  router.post('/schedule', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        userId: z.uuid(),
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
        note: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    if (
      input.endsAt <= input.startsAt ||
      input.endsAt.getTime() - input.startsAt.getTime() > 24 * 3_600_000
    )
      throw errors.validation([{ path: 'endsAt' }]);
    const branch = await resolveBranch(db, auth, input.branchId);
    const user = await db.user.findFirst({
      where: { id: input.userId, tenantId: auth.tenantId, status: 'ACTIVE' },
    });
    if (!user) throw errors.validation([{ path: 'userId' }]);
    // A person cannot be scheduled twice at the same time.
    const overlap = await db.scheduledShift.count({
      where: {
        userId: input.userId,
        startsAt: { lt: input.endsAt },
        endsAt: { gt: input.startsAt },
      },
    });
    if (overlap > 0) throw errors.conflict();
    const shift = await db.scheduledShift.create({
      data: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        userId: input.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        note: input.note ?? null,
      },
    });
    res.status(201).json({ id: shift.id });
  });

  router.delete('/schedule/:id', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.scheduledShift.deleteMany({
      where: { id, tenantId: auth.tenantId },
    });
    if (result.count === 0) throw errors.notFound();
    res.status(204).end();
  });

  // --- Payroll ------------------------------------------------------------------

  router.post(
    '/payroll/adjustments',
    ...hr,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z.object({
          userId: z.uuid(),
          type: z.enum(['BONUS', 'PENALTY', 'ADVANCE']),
          amount: z.number().int().min(1).max(1_000_000_000),
          date: isoDate,
          reason: z.string().trim().min(3).max(200),
        }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: input.userId, tenantId: auth.tenantId },
        });
        if (!user) throw errors.validation([{ path: 'userId' }]);
        await assertOpenPeriod(tx, auth.tenantId, dayStart(input.date));
        const created = await tx.payrollAdjustment.create({
          data: {
            tenantId: auth.tenantId,
            userId: input.userId,
            type: input.type,
            amount: input.amount,
            date: dayStart(input.date),
            reason: input.reason,
            createdById: auth.userId,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'payroll.adjustment',
          entityType: 'user',
          entityId: input.userId,
          data: { id: created.id, type: input.type, amount: input.amount },
        });
      });
      res.status(201).json({ ok: true });
    },
  );

  const canSeePayroll = (auth: AuthContext) =>
    auth.permissions.has('hr.manage') || auth.permissions.has('finance.view');

  router.get('/payroll/periods', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (!canSeePayroll(auth)) throw errors.forbidden();
    const periods = await db.payrollPeriod.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { startDate: 'desc' },
      include: { lines: { select: { total: true } } },
    });
    res.json({
      periods: periods.map(({ lines, ...period }) => ({
        ...period,
        total: lines.reduce((sum, line) => sum + line.total, 0),
        employees: lines.length,
      })),
    });
  });

  router.post('/payroll/periods', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({ startDate: isoDate, endDate: isoDate }),
      req.body,
    );
    if (input.endDate < input.startDate)
      throw errors.validation([{ path: 'endDate' }]);
    try {
      const period = await db.$transaction(async (tx) => {
        const created = await tx.payrollPeriod.create({
          data: {
            tenantId: auth.tenantId,
            startDate: dayStart(input.startDate),
            endDate: dayStart(input.endDate),
          },
        });
        await computePayroll(tx, auth.tenantId, created.id);
        return created;
      });
      res.status(201).json({ id: period.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.get('/payroll/periods/:id', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (!canSeePayroll(auth)) throw errors.forbidden();
    const id = parse(z.uuid(), req.params.id);
    const period = await db.payrollPeriod.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { lines: true },
    });
    if (!period) throw errors.notFound();
    const users = await db.user.findMany({
      where: { id: { in: period.lines.map((line) => line.userId) } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    res.json({
      ...period,
      lines: period.lines.map((line) => ({
        ...line,
        name: names.get(line.userId) ?? '—',
      })),
    });
  });

  router.post('/payroll/periods/:id/recalculate', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const period = await tx.payrollPeriod.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!period) throw errors.notFound();
      if (period.status !== 'DRAFT')
        throw new AppError(409, 'PAYROLL_LOCKED', 'payrollLocked');
      await computePayroll(tx, auth.tenantId, id);
    });
    res.json({ ok: true });
  });

  // Approval locks the period; it needs finance rights and re-authentication.
  router.post(
    '/payroll/periods/:id/approve',
    requireAuth(),
    requirePermission('finance.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.payrollPeriod.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'DRAFT' },
        data: {
          status: 'APPROVED',
          approvedById: auth.userId,
          approvedAt: now(),
        },
      });
      if (result.count === 0)
        throw new AppError(409, 'PAYROLL_LOCKED', 'payrollLocked');
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'payroll.approve',
        entityType: 'payroll_period',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/payroll/periods/:id/paid',
    requireAuth(),
    requirePermission('finance.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.payrollPeriod.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'APPROVED' },
        data: { status: 'PAID', paidAt: now() },
      });
      if (result.count === 0)
        throw new AppError(409, 'PAYROLL_LOCKED', 'payrollLocked');
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'payroll.paid',
        entityType: 'payroll_period',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  router.get('/payroll/periods/:id/export.csv', ...hr, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const period = await db.payrollPeriod.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { lines: true },
    });
    if (!period) throw errors.notFound();
    const users = await db.user.findMany({
      where: { id: { in: period.lines.map((line) => line.userId) } },
      select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    const rows = period.lines.map((line) =>
      [
        names.get(line.userId) ?? '',
        line.payType,
        line.workedMinutes,
        line.overtimeMinutes,
        line.baseAmount,
        line.overtimeAmount,
        line.bonuses,
        line.penalties,
        line.advances,
        line.total,
      ].join(';'),
    );
    res.type('text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ish-haqi-${period.startDate.toISOString().slice(0, 10)}.csv"`,
    );
    // BOM + semicolons so Excel opens Cyrillic/Latin text and columns correctly.
    res.send(
      `﻿xodim;turi;daqiqa;qoshimcha_daqiqa;asosiy;qoshimcha;bonus;jarima;avans;jami\n${rows.join('\n')}`,
    );
  });

  return router;
}
