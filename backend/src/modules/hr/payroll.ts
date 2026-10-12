import type { Tx } from '../../db.js';
import { AppError } from '../../http/errors.js';

const DAY = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Months closed for financial changes reject back-dated entries. */
export async function assertOpenPeriod(tx: Tx, tenantId: string, date: Date) {
  const month = isoDay(date).slice(0, 7);
  const closed = await tx.closedPeriod.findUnique({
    where: { tenantId_month: { tenantId, month } },
  });
  if (closed)
    throw new AppError(409, 'PERIOD_CLOSED', 'periodClosed', { month });
}

/** Day key in Tashkent time, used to split worked minutes per calendar day. */
const tashkentDay = (date: Date) =>
  isoDay(new Date(date.getTime() + 5 * 3_600_000));

/**
 * Computes payroll lines for a period from closed attendance records and adjustments.
 * HOURLY: regular minutes × rate/60, plus daily overtime beyond the configured
 * threshold at the configured multiplier. MONTHLY: salary prorated by calendar days
 * of the starting month (no overtime). Bonuses add, penalties and advances deduct.
 */
export async function computePayroll(
  tx: Tx,
  tenantId: string,
  periodId: string,
) {
  const period = await tx.payrollPeriod.findUniqueOrThrow({
    where: { id: periodId },
  });
  const profile = await tx.tenantProfile.findUnique({ where: { tenantId } });
  const overtimeAfter = profile?.overtimeAfterMinutes ?? 480;
  const multiplierBp = profile?.overtimeMultiplierBp ?? 15000;
  const start = period.startDate;
  const endExclusive = new Date(period.endDate.getTime() + DAY);
  const employees = await tx.employeeProfile.findMany({
    where: { tenantId, payType: { not: 'NONE' } },
  });
  const [records, adjustments] = await Promise.all([
    tx.attendanceRecord.findMany({
      where: {
        tenantId,
        clockIn: { gte: start, lt: endExclusive },
        clockOut: { not: null },
      },
    }),
    tx.payrollAdjustment.findMany({
      where: { tenantId, date: { gte: start, lte: period.endDate } },
    }),
  ]);
  const periodDays = Math.round(
    (endExclusive.getTime() - start.getTime()) / DAY,
  );
  const monthDays = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();

  await tx.payrollLine.deleteMany({ where: { periodId } });
  for (const employee of employees) {
    const perDay = new Map<string, number>();
    for (const record of records.filter(
      (row) => row.userId === employee.userId,
    )) {
      const minutes = Math.floor(
        (record.clockOut!.getTime() - record.clockIn.getTime()) / 60_000,
      );
      const day = tashkentDay(record.clockIn);
      perDay.set(day, (perDay.get(day) ?? 0) + minutes);
    }
    let worked = 0;
    let overtime = 0;
    for (const minutes of perDay.values()) {
      worked += minutes;
      overtime += Math.max(0, minutes - overtimeAfter);
    }
    let base = 0;
    let overtimeAmount = 0;
    if (employee.payType === 'HOURLY') {
      base = Math.round(((worked - overtime) * employee.rate) / 60);
      overtimeAmount = Math.round(
        (overtime * employee.rate * multiplierBp) / 60 / 10_000,
      );
    } else {
      base = Math.round(
        (employee.rate * Math.min(periodDays, monthDays)) / monthDays,
      );
      overtime = 0;
    }
    const mine = adjustments.filter((row) => row.userId === employee.userId);
    const sum = (type: string) =>
      mine
        .filter((row) => row.type === type)
        .reduce((total, row) => total + row.amount, 0);
    const bonuses = sum('BONUS');
    const penalties = sum('PENALTY');
    const advances = sum('ADVANCE');
    await tx.payrollLine.create({
      data: {
        tenantId,
        periodId,
        userId: employee.userId,
        payType: employee.payType,
        rate: employee.rate,
        workedMinutes: worked,
        overtimeMinutes: overtime,
        baseAmount: base,
        overtimeAmount,
        bonuses,
        penalties,
        advances,
        total: base + overtimeAmount + bonuses - penalties - advances,
      },
    });
  }
}
