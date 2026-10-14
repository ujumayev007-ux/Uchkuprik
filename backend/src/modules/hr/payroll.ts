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
    where: {
      tenantId,
      OR: [
        { payType: { not: 'NONE' } },
        { perOrder: { gt: 0 } },
        { perCustomer: { gt: 0 } },
        { salesPercentBp: { gt: 0 } },
        { qualityBonus: { gt: 0 } },
      ],
    },
  });
  // Completed orders per employee in the period (commissions; refunds excluded).
  const orders = await tx.order.findMany({
    where: {
      tenantId,
      status: 'COMPLETED',
      completedAt: { gte: start, lt: endExclusive },
      createdById: { in: employees.map((e) => e.userId) },
    },
    select: {
      id: true,
      createdById: true,
      customerId: true,
      total: true,
      refundedTotal: true,
    },
  });
  const ratings = await tx.feedback.findMany({
    where: { tenantId, orderId: { in: orders.map((order) => order.id) } },
    select: { orderId: true, rating: true },
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
    } else if (employee.payType === 'DAILY') {
      base = employee.rate * perDay.size;
      overtime = 0;
    } else if (employee.payType === 'SHIFT') {
      base =
        employee.rate *
        records.filter((row) => row.userId === employee.userId).length;
      overtime = 0;
    } else if (employee.payType === 'MONTHLY') {
      base = Math.round(
        (employee.rate * Math.min(periodDays, monthDays)) / monthDays,
      );
      overtime = 0;
    } else overtime = 0;
    const sold = orders.filter(
      (order) => order.createdById === employee.userId,
    );
    const customers = new Set(
      sold.map((order) => order.customerId).filter((id) => id !== null),
    ).size;
    const netSales = sold.reduce(
      (total, order) => total + order.total - order.refundedTotal,
      0,
    );
    const commission =
      employee.perOrder * sold.length +
      employee.perCustomer * customers +
      Math.round((netSales * employee.salesPercentBp) / 10_000);
    const mine = adjustments.filter((row) => row.userId === employee.userId);
    const sum = (type: string) =>
      mine
        .filter((row) => row.type === type)
        .reduce((total, row) => total + row.amount, 0);
    // Quality bonus: at least 3 rated orders with an average at the minimum.
    const mineRated = ratings.filter((row) =>
      sold.some((order) => order.id === row.orderId),
    );
    const average = mineRated.length
      ? mineRated.reduce((total, row) => total + row.rating, 0) /
        mineRated.length
      : 0;
    const quality =
      employee.qualityBonus > 0 &&
      mineRated.length >= 3 &&
      average >= employee.qualityMinRating
        ? employee.qualityBonus
        : 0;
    const bonuses = sum('BONUS') + quality;
    const penalties = sum('PENALTY');
    // Loan repayments are deducted like advances; loans themselves are not.
    const advances = sum('ADVANCE') + sum('REPAYMENT');
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
        commission,
        total:
          base + overtimeAmount + commission + bonuses - penalties - advances,
      },
    });
  }
}
