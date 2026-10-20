import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors } from '../../http/errors.js';
import type { AuthContext } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { businessDate } from '../orders/engine.js';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const salesQuery = z.object({
  branchId: z.uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type SalesQuery = z.infer<typeof salesQuery>;

/** Inclusive business-date range in the branch's own timezone (default: today). */
export async function reportRange(
  services: Services,
  auth: AuthContext,
  query: SalesQuery,
) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const branch = await resolveBranch(db, auth, query.branchId);
  const today = businessDate(now, branch.timezone).toISOString().slice(0, 10);
  const from = new Date(`${query.from ?? today}T00:00:00.000Z`);
  const to = new Date(`${query.to ?? today}T00:00:00.000Z`);
  if (from > to || to.getTime() - from.getTime() > 366 * 86_400_000)
    throw errors.validation([{ path: 'from' }]);
  return { branch, from, to };
}

/**
 * The sales dataset behind the screen and every export (Excel, Word, PDF), so all of
 * them reconcile. `full` adds the complete product list and the category breakdown.
 * Money is in so‘m. Cost and margin stay restricted financial data.
 */
export async function loadSales(
  services: Services,
  auth: AuthContext,
  query: SalesQuery,
  full = false,
) {
  const { db } = services;
  const { branch, from, to } = await reportRange(services, auth, query);

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
        take: full ? 500 : 10,
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
        in: byCashier.map((row) => row.createdById).filter((id) => id !== null),
      },
    },
    select: { id: true, displayName: true },
  });
  const names = new Map(users.map((user) => [user.id, user.displayName]));
  const orderCount = orders._count;
  const salesTotal = orders._sum.total ?? 0;

  // Cost and margin are restricted financial data.
  let profit:
    { costOfGoods: number; grossProfit: number; marginBp: number } | undefined;
  if (
    auth.permissions.has('finance.view') &&
    auth.financial.margin &&
    auth.reportFields.margin
  ) {
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

  let categories: { name: string; quantity: number; revenue: number }[] = [];
  let shifts: {
    cashier: string;
    openedAt: Date;
    closedAt: Date | null;
    openingCash: number;
    expectedCash: number | null;
    countedCash: number | null;
    variance: number | null;
  }[] = [];
  if (full) {
    const rows = await db.$queryRaw<
      { name: string; quantity: bigint; revenue: bigint }[]
    >`
        SELECT c.name AS name, SUM(i.quantity)::bigint AS quantity, SUM(i."lineTotal")::bigint AS revenue
        FROM order_items i
        JOIN orders o ON o.id = i."orderId"
        JOIN product_variants v ON v.id = i."variantId"
        JOIN products p ON p.id = v."productId"
        JOIN menu_categories c ON c.id = p."categoryId"
        WHERE o."tenantId" = ${auth.tenantId}::uuid AND o."branchId" = ${branch.id}::uuid
          AND o."businessDate" BETWEEN ${from}::date AND ${to}::date
          AND o.status <> 'CANCELLED' AND i.status = 'ACTIVE'
        GROUP BY c.name ORDER BY revenue DESC`;
    categories = rows.map((row) => ({
      name: row.name,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue),
    }));
    const shiftRows = await db.cashShift.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        openedAt: {
          gte: new Date(from.getTime() - 86_400_000),
          lte: new Date(to.getTime() + 2 * 86_400_000),
        },
      },
      orderBy: { openedAt: 'asc' },
      take: 500,
    });
    const shiftUsers = await db.user.findMany({
      where: { id: { in: shiftRows.map((shift) => shift.openedById) } },
      select: { id: true, displayName: true },
    });
    const shiftNames = new Map(
      shiftUsers.map((user) => [user.id, user.displayName]),
    );
    shifts = shiftRows.map((shift) => ({
      cashier: shiftNames.get(shift.openedById) ?? '—',
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      openingCash: shift.openingCash,
      expectedCash: shift.expectedCash,
      countedCash: shift.countedCash,
      variance: shift.variance,
    }));
  }

  return {
    branch,
    report: {
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
    },
    categories,
    shifts,
  };
}
