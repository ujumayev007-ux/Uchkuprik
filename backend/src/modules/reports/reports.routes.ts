import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { businessDate } from '../orders/engine.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function reportsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  // Sales summary for a branch over business dates (inclusive). Money in so‘m.
  router.get(
    '/reports/sales',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const today = businessDate(now(), branch.timezone)
        .toISOString()
        .slice(0, 10);
      const from = new Date(`${query.from ?? today}T00:00:00.000Z`);
      const to = new Date(`${query.to ?? today}T00:00:00.000Z`);
      if (from > to || to.getTime() - from.getTime() > 366 * 86_400_000)
        throw errors.validation([{ path: 'from' }]);

      const orderWhere = {
        tenantId: auth.tenantId,
        branchId: branch.id,
        businessDate: { gte: from, lte: to },
      };
      const [orders, cancelled, payments, refunds, items, byCashier] =
        await Promise.all([
          db.order.aggregate({
            where: { ...orderWhere, status: { not: 'CANCELLED' } },
            _count: true,
            _sum: {
              total: true,
              discountTotal: true,
              serviceCharge: true,
              subtotal: true,
            },
          }),
          db.order.count({ where: { ...orderWhere, status: 'CANCELLED' } }),
          db.payment.groupBy({
            by: ['method'],
            where: { tenantId: auth.tenantId, order: orderWhere },
            _sum: { amount: true },
            _count: true,
          }),
          db.refund.groupBy({
            by: ['method'],
            where: { tenantId: auth.tenantId, order: orderWhere },
            _sum: { amount: true },
            _count: true,
          }),
          db.orderItem.groupBy({
            by: ['productName'],
            where: {
              tenantId: auth.tenantId,
              status: 'ACTIVE',
              order: { ...orderWhere, status: { not: 'CANCELLED' } },
            },
            _sum: { quantity: true, lineTotal: true },
            orderBy: { _sum: { lineTotal: 'desc' } },
            take: 10,
          }),
          db.payment.groupBy({
            by: ['createdById'],
            where: { tenantId: auth.tenantId, order: orderWhere },
            _sum: { amount: true },
            _count: true,
          }),
        ]);
      const paymentsTotal = payments.reduce(
        (sum, row) => sum + (row._sum.amount ?? 0),
        0,
      );
      const refundsTotal = refunds.reduce(
        (sum, row) => sum + (row._sum.amount ?? 0),
        0,
      );
      const users = await db.user.findMany({
        where: {
          id: {
            in: byCashier
              .map((row) => row.createdById)
              .filter((id) => id !== null),
          },
        },
        select: { id: true, displayName: true },
      });
      const names = new Map(users.map((user) => [user.id, user.displayName]));
      const orderCount = orders._count;
      const salesTotal = orders._sum.total ?? 0;

      // Cost and margin are restricted financial data.
      let profit:
        | { costOfGoods: number; grossProfit: number; marginBp: number }
        | undefined;
      if (auth.permissions.has('finance.view')) {
        const rows = await db.$queryRaw<{ cost: bigint | null }[]>`
        SELECT SUM(COALESCE(i."unitCost", 0) * i.quantity)::bigint AS cost
        FROM order_items i JOIN orders o ON o.id = i."orderId"
        WHERE o."tenantId" = ${auth.tenantId}::uuid AND o."branchId" = ${branch.id}::uuid
          AND o."businessDate" BETWEEN ${from}::date AND ${to}::date
          AND o.status <> 'CANCELLED' AND i.status = 'ACTIVE'`;
        const costOfGoods = Number(rows[0]?.cost ?? 0);
        const netSales = salesTotal - (orders._sum.serviceCharge ?? 0);
        profit = {
          costOfGoods,
          grossProfit: netSales - costOfGoods,
          marginBp:
            netSales > 0
              ? Math.round(((netSales - costOfGoods) * 10_000) / netSales)
              : 0,
        };
      }

      res.json({
        branchId: branch.id,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        orders: orderCount,
        cancelledOrders: cancelled,
        salesTotal,
        subtotal: orders._sum.subtotal ?? 0,
        discounts: orders._sum.discountTotal ?? 0,
        serviceCharges: orders._sum.serviceCharge ?? 0,
        averageCheck: orderCount > 0 ? Math.round(salesTotal / orderCount) : 0,
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
        collected: paymentsTotal - refundsTotal,
        topProducts: items.map((row) => ({
          name: row.productName,
          quantity: row._sum.quantity ?? 0,
          revenue: row._sum.lineTotal ?? 0,
        })),
        cashiers: byCashier.map((row) => ({
          name: row.createdById ? (names.get(row.createdById) ?? '—') : '—',
          amount: row._sum.amount ?? 0,
          count: row._count,
        })),
        ...(profit ? { profit } : {}),
      });
    },
  );

  return router;
}
