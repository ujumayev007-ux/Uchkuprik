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
import { assertOpenPeriod } from '../hr/payroll.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({
  branchId: z.uuid().optional(),
  from: isoDate,
  to: isoDate,
});
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function csv(
  res: import('express').Response,
  filename: string,
  header: string[],
  rows: (string | number)[][],
) {
  const escape = (value: string | number) =>
    typeof value === 'number'
      ? String(value)
      : `"${value.replace(/"/g, '""')}"`;
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM and semicolons make the file open correctly in Excel with Uzbek text.
  res.send(
    `﻿${header.join(';')}\n${rows.map((row) => row.map(escape).join(';')).join('\n')}`,
  );
}

export function financeRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const view = [requireAuth(), requirePermission('finance.view')];
  const manage = [requireAuth(), requirePermission('finance.manage')];

  // --- Expenses -----------------------------------------------------------------

  router.get('/expenses', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(range, req.query);
    const branch = await resolveBranch(db, auth, query.branchId);
    const expenses = await db.expense.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        date: { gte: day(query.from), lte: day(query.to) },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ expenses });
  });

  router.post('/expenses', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        category: z.string().trim().min(2).max(60),
        amount: z.number().int().min(1).max(10_000_000_000),
        date: isoDate,
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const expense = await db.$transaction(async (tx) => {
      await assertOpenPeriod(tx, auth.tenantId, day(input.date));
      const created = await tx.expense.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          category: input.category,
          amount: input.amount,
          date: day(input.date),
          note: input.note ?? null,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'expense.create',
        entityType: 'expense',
        entityId: created.id,
        data: { category: input.category, amount: input.amount },
      });
      return created;
    });
    res.status(201).json({ id: expense.id });
  });

  router.delete('/expenses/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const expense = await tx.expense.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!expense) throw errors.notFound();
      await resolveBranch(tx, auth, expense.branchId);
      await assertOpenPeriod(tx, auth.tenantId, expense.date);
      await tx.expense.delete({ where: { id } });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: expense.branchId,
        actorUserId: auth.userId,
        action: 'expense.delete',
        entityType: 'expense',
        entityId: id,
        data: { category: expense.category, amount: expense.amount },
      });
    });
    res.status(204).end();
  });

  // --- Period closing --------------------------------------------------------------

  router.get('/finance/closed-periods', ...view, async (_req, res) => {
    const auth = getAuth(res);
    res.json({
      periods: await db.closedPeriod.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { month: 'desc' },
      }),
    });
  });

  router.post(
    '/finance/close',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const { month } = parse(
        z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
        req.body,
      );
      const current = (services.now?.() ?? new Date())
        .toISOString()
        .slice(0, 7);
      // Only finished months can be closed.
      if (month >= current) throw errors.validation([{ path: 'month' }]);
      try {
        await db.closedPeriod.create({
          data: { tenantId: auth.tenantId, month, closedById: auth.userId },
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(409, 'PERIOD_CLOSED', 'periodClosed', { month });
        throw error;
      }
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'finance.period.close',
        data: { month },
      });
      res.status(201).json({ ok: true });
    },
  );

  // --- Profit and loss -------------------------------------------------------------

  const pnl = async (
    auth: AuthContext,
    branchId: string,
    from: string,
    to: string,
  ) => {
    const start = day(from);
    const end = day(to);
    const endExclusive = new Date(end.getTime() + 86_400_000);
    const [sales, cogsRecipes, cogsManual, expenses, payroll] =
      await Promise.all([
        db.order.aggregate({
          where: {
            tenantId: auth.tenantId,
            branchId,
            status: 'COMPLETED',
            businessDate: { gte: start, lte: end },
          },
          _sum: {
            total: true,
            discountTotal: true,
            serviceCharge: true,
            deliveryFee: true,
          },
          _count: true,
        }),
        // Recipe-based cost of goods: SALE movements valued at average cost.
        db.$queryRaw<{ cost: number | null }[]>`
        SELECT COALESCE(SUM(-m.quantity * m."unitCost"), 0)::float AS cost
        FROM stock_movements m JOIN warehouses w ON w.id = m."warehouseId"
        WHERE m."tenantId" = ${auth.tenantId}::uuid AND w."branchId" = ${branchId}::uuid
          AND m.type = 'SALE' AND m."createdAt" >= ${start} AND m."createdAt" < ${endExclusive}`,
        // Items without recipes fall back to the manual unit cost snapshot.
        db.$queryRaw<{ cost: bigint | null }[]>`
        SELECT COALESCE(SUM(COALESCE(i."unitCost", 0) * i.quantity), 0)::bigint AS cost
        FROM order_items i JOIN orders o ON o.id = i."orderId"
        WHERE o."tenantId" = ${auth.tenantId}::uuid AND o."branchId" = ${branchId}::uuid AND o.status = 'COMPLETED'
          AND o."businessDate" BETWEEN ${start}::date AND ${end}::date AND i.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM recipe_lines r WHERE r."variantId" = i."variantId")`,
        db.expense.groupBy({
          by: ['category'],
          where: {
            tenantId: auth.tenantId,
            branchId,
            date: { gte: start, lte: end },
          },
          _sum: { amount: true },
        }),
        db.payrollLine.aggregate({
          where: {
            tenantId: auth.tenantId,
            period: {
              status: { in: ['APPROVED', 'PAID'] },
              startDate: { gte: start, lte: end },
            },
          },
          _sum: { total: true },
        }),
      ]);
    const revenue = sales._sum.total ?? 0;
    const cogs = Math.round(
      Number(cogsRecipes[0]?.cost ?? 0) + Number(cogsManual[0]?.cost ?? 0),
    );
    const expenseTotal = expenses.reduce(
      (sum, row) => sum + (row._sum.amount ?? 0),
      0,
    );
    const payrollTotal = payroll._sum.total ?? 0;
    return {
      from,
      to,
      orders: sales._count,
      revenue,
      discounts: sales._sum.discountTotal ?? 0,
      serviceCharges: sales._sum.serviceCharge ?? 0,
      deliveryFees: sales._sum.deliveryFee ?? 0,
      cogs,
      grossProfit: revenue - cogs,
      expenses: expenses.map((row) => ({
        category: row.category,
        amount: row._sum.amount ?? 0,
      })),
      expenseTotal,
      payroll: payrollTotal,
      netProfit: revenue - cogs - expenseTotal - payrollTotal,
    };
  };

  router.get('/reports/pnl', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(range, req.query);
    const branch = await resolveBranch(db, auth, query.branchId);
    res.json(await pnl(auth, branch.id, query.from, query.to));
  });

  router.get('/reports/pnl.csv', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(range, req.query);
    const branch = await resolveBranch(db, auth, query.branchId);
    const report = await pnl(auth, branch.id, query.from, query.to);
    csv(
      res,
      `foyda-zarar-${query.from}-${query.to}.csv`,
      ['modda', 'summa'],
      [
        ['Tushum', report.revenue],
        ['Tannarx', report.cogs],
        ['Yalpi foyda', report.grossProfit],
        ...report.expenses.map(
          (row) => [`Xarajat: ${row.category}`, row.amount] as [string, number],
        ),
        ['Ish haqi', report.payroll],
        ['Sof foyda', report.netProfit],
      ],
    );
  });

  // --- Branch comparison and kitchen performance ----------------------------------

  router.get(
    '/reports/branches',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(z.object({ from: isoDate, to: isoDate }), req.query);
      const branches = await db.branch.findMany({
        where: {
          tenantId: auth.tenantId,
          deletedAt: null,
          ...(auth.allBranches ? {} : { id: { in: auth.branchIds } }),
        },
        orderBy: { name: 'asc' },
      });
      const rows = await db.order.groupBy({
        by: ['branchId'],
        where: {
          tenantId: auth.tenantId,
          branchId: { in: branches.map((b) => b.id) },
          status: 'COMPLETED',
          businessDate: { gte: day(query.from), lte: day(query.to) },
        },
        _sum: { total: true },
        _count: true,
      });
      const costs = auth.permissions.has('finance.view');
      const result = [];
      for (const branch of branches) {
        const row = rows.find((item) => item.branchId === branch.id);
        const sales = row?._sum.total ?? 0;
        const orders = row?._count ?? 0;
        result.push({
          branchId: branch.id,
          name: branch.name,
          orders,
          sales,
          averageCheck: orders ? Math.round(sales / orders) : 0,
          ...(costs
            ? await pnl(auth, branch.id, query.from, query.to).then((p) => ({
                cogs: p.cogs,
                grossProfit: p.grossProfit,
                netProfit: p.netProfit,
              }))
            : {}),
        });
      }
      res.json({ branches: result });
    },
  );

  router.get(
    '/reports/kitchen',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(range, req.query);
      const branch = await resolveBranch(db, auth, query.branchId);
      const rows = await db.$queryRaw<
        { orders: number; avg_minutes: number | null; late: number }[]
      >`
      SELECT COUNT(*)::int AS orders,
             AVG(EXTRACT(EPOCH FROM (o."readyAt" - o."placedAt")) / 60)::float AS avg_minutes,
             COUNT(*) FILTER (
               WHERE EXTRACT(EPOCH FROM (o."readyAt" - o."placedAt")) / 60 >
                 COALESCE((SELECT MAX(i."prepTimeMinutes") FROM order_items i WHERE i."orderId" = o.id AND i.status = 'ACTIVE'), 15)
             )::int AS late
      FROM orders o
      WHERE o."tenantId" = ${auth.tenantId}::uuid AND o."branchId" = ${branch.id}::uuid
        AND o."readyAt" IS NOT NULL AND o."placedAt" IS NOT NULL
        AND o."businessDate" BETWEEN ${day(query.from)}::date AND ${day(query.to)}::date`;
      const row = rows[0] ?? { orders: 0, avg_minutes: null, late: 0 };
      res.json({
        orders: row.orders,
        averageMinutes:
          row.avg_minutes === null
            ? null
            : Math.round(row.avg_minutes * 10) / 10,
        lateOrders: row.late,
        onTimePercent: row.orders
          ? Math.round(((row.orders - row.late) / row.orders) * 100)
          : null,
      });
    },
  );

  router.get(
    '/reports/sales.csv',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(range, req.query);
      const branch = await resolveBranch(db, auth, query.branchId);
      const rows = await db.order.groupBy({
        by: ['businessDate'],
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          status: { not: 'CANCELLED' },
          businessDate: { gte: day(query.from), lte: day(query.to) },
        },
        _sum: { total: true, discountTotal: true },
        _count: true,
        orderBy: { businessDate: 'asc' },
      });
      csv(
        res,
        `savdo-${query.from}-${query.to}.csv`,
        ['sana', 'buyurtmalar', 'savdo', 'chegirmalar'],
        rows.map((row) => [
          row.businessDate.toISOString().slice(0, 10),
          row._count,
          row._sum.total ?? 0,
          row._sum.discountTotal ?? 0,
        ]),
      );
    },
  );

  return router;
}
