import { timingSafeEqual } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { renderMetrics } from '../../lib/metrics.js';
import { canAccessBranch, getAuth, requireAuth } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

const DAY = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function requireAny(...keys: string[]) {
  return (_req: unknown, res: Response, next: () => void) => {
    const auth = getAuth(res);
    if (
      auth.tenantKind !== 'BUSINESS' ||
      !keys.some((key) => auth.permissions.has(key as never))
    )
      throw errors.forbidden();
    next();
  };
}

export function insightsRouter(services: Services, metricsToken?: string) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  // ------------------------------------------------------------- metrics

  // Prometheus scrape endpoint; disabled unless METRICS_TOKEN is configured.
  router.get('/metrics', async (req, res) => {
    const provided = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (
      !metricsToken ||
      !timingSafeEqual(
        Buffer.from(sha256(provided)),
        Buffer.from(sha256(metricsToken)),
      )
    ) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    const [print, notifications, webhooks, failedNotifications] =
      await Promise.all([
        db.printJob.count({ where: { status: 'PENDING' } }),
        db.notificationJob.count({ where: { status: 'PENDING' } }),
        db.webhookDelivery.count({ where: { status: 'PENDING' } }),
        db.notificationJob.count({ where: { status: 'FAILED' } }),
      ]);
    res.type('text/plain; version=0.0.4');
    res.send(
      renderMetrics({
        ff_print_jobs_pending: print,
        ff_notification_jobs_pending: notifications,
        ff_notification_jobs_failed: failedNotifications,
        ff_webhook_deliveries_pending: webhooks,
      }),
    );
  });

  // ------------------------------------------------------------ forecast

  /**
   * Revenue and order forecast per day: average of the same weekday over the last
   * eight weeks (a transparent statistical baseline, no external AI service).
   */
  router.get(
    '/reports/forecast',
    requireAuth(),
    requireAny('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          days: z.coerce.number().int().min(1).max(14).default(7),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      const today = day(now().toISOString().slice(0, 10));
      const since = new Date(today.getTime() - 56 * DAY);
      const rows = await db.order.groupBy({
        by: ['businessDate'],
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          status: 'COMPLETED',
          businessDate: { gte: since, lt: today },
        },
        _sum: { total: true },
        _count: true,
      });
      const history = new Map(
        rows.map((row) => [
          row.businessDate.toISOString().slice(0, 10),
          { revenue: row._sum.total ?? 0, orders: row._count },
        ]),
      );
      const forecast = [];
      for (let offset = 0; offset < query.days; offset++) {
        const date = new Date(today.getTime() + offset * DAY);
        const samples = [];
        for (let week = 1; week <= 8; week++) {
          const past = new Date(date.getTime() - week * 7 * DAY);
          if (past < since || past >= today) continue;
          samples.push(
            history.get(past.toISOString().slice(0, 10)) ?? {
              revenue: 0,
              orders: 0,
            },
          );
        }
        const n = samples.length || 1;
        forecast.push({
          date: date.toISOString().slice(0, 10),
          weekday: date.getUTCDay(),
          revenue: Math.round(
            samples.reduce((sum, s) => sum + s.revenue, 0) / n,
          ),
          orders: Math.round(samples.reduce((sum, s) => sum + s.orders, 0) / n),
          basedOnWeeks: samples.length,
        });
      }
      res.json({ branchId: branch.id, method: 'weekday-average-8w', forecast });
    },
  );

  // ---------------------------------------------------------- risk signals

  /**
   * Per-employee risk indicators: cancellations after placing, item voids, refunds,
   * discounts and cash shortages, flagged when far above the team median or above
   * absolute thresholds. Signals are prompts for review, not accusations.
   */
  router.get(
    '/reports/risk',
    requireAuth(),
    requireAny('audit.view', 'finance.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(z.object({ from: isoDate, to: isoDate }), req.query);
      const from = day(query.from);
      const to = new Date(day(query.to).getTime() + DAY);
      if (to <= from || to.getTime() - from.getTime() > 93 * DAY)
        throw errors.validation([{ path: 'to' }]);
      const branchFilter = auth.allBranches
        ? {}
        : { branchId: { in: auth.branchIds } };
      const [events, refunds, sales, shifts, users] = await Promise.all([
        db.orderEvent.findMany({
          where: {
            tenantId: auth.tenantId,
            createdAt: { gte: from, lt: to },
            type: { in: ['status', 'item_cancelled', 'discount'] },
            actorId: { not: null },
            order: branchFilter,
          },
          select: { type: true, data: true, actorId: true },
        }),
        db.refund.groupBy({
          by: ['approvedById'],
          where: {
            tenantId: auth.tenantId,
            createdAt: { gte: from, lt: to },
            order: branchFilter,
          },
          _sum: { amount: true },
          _count: true,
        }),
        db.order.groupBy({
          by: ['createdById'],
          where: {
            tenantId: auth.tenantId,
            status: 'COMPLETED',
            completedAt: { gte: from, lt: to },
            createdById: { not: null },
            ...branchFilter,
          },
          _sum: { total: true, discountTotal: true },
          _count: true,
        }),
        db.cashShift.findMany({
          where: {
            tenantId: auth.tenantId,
            status: 'CLOSED',
            closedAt: { gte: from, lt: to },
            ...branchFilter,
          },
          select: { openedById: true, variance: true, branchId: true },
        }),
        db.user.findMany({
          where: { tenantId: auth.tenantId },
          select: { id: true, displayName: true },
        }),
      ]);
      type Row = {
        userId: string;
        name: string;
        sales: number;
        orders: number;
        discounts: number;
        cancellations: number;
        voids: number;
        refunds: number;
        refundAmount: number;
        cashShortage: number;
      };
      const rows = new Map<string, Row>();
      const row = (userId: string) => {
        let value = rows.get(userId);
        if (!value) {
          value = {
            userId,
            name: users.find((user) => user.id === userId)?.displayName ?? '—',
            sales: 0,
            orders: 0,
            discounts: 0,
            cancellations: 0,
            voids: 0,
            refunds: 0,
            refundAmount: 0,
            cashShortage: 0,
          };
          rows.set(userId, value);
        }
        return value;
      };
      for (const event of events) {
        const data = (event.data ?? {}) as { to?: string; from?: string };
        if (
          event.type === 'status' &&
          data.to === 'CANCELLED' &&
          data.from !== 'DRAFT'
        )
          row(event.actorId!).cancellations += 1;
        if (event.type === 'item_cancelled') row(event.actorId!).voids += 1;
      }
      for (const refund of refunds) {
        const target = row(refund.approvedById);
        target.refunds = refund._count;
        target.refundAmount = refund._sum.amount ?? 0;
      }
      for (const sale of sales) {
        const target = row(sale.createdById!);
        target.sales = sale._sum.total ?? 0;
        target.orders = sale._count;
        target.discounts = sale._sum.discountTotal ?? 0;
      }
      for (const shift of shifts)
        if ((shift.variance ?? 0) < 0 && canAccessBranch(auth, shift.branchId))
          row(shift.openedById).cashShortage += -(shift.variance ?? 0);
      const list = [...rows.values()];
      const medians = {
        cancellations: median(list.map((r) => r.cancellations)),
        voids: median(list.map((r) => r.voids)),
      };
      // Each person is compared with the median of their colleagues.
      const othersMedian = (r: Row, pick: (row: Row) => number) =>
        median(list.filter((other) => other !== r).map(pick));
      const result = list
        .map((r) => {
          const flags: string[] = [];
          const cancellationsBase = othersMedian(r, (row) => row.cancellations);
          const voidsBase = othersMedian(r, (row) => row.voids);
          if (
            r.cancellations >= 3 &&
            r.cancellations > 3 * Math.max(1, cancellationsBase)
          )
            flags.push('CANCELLATIONS');
          if (r.voids >= 5 && r.voids > 3 * Math.max(1, voidsBase))
            flags.push('VOIDS');
          if (
            r.refundAmount > 0 &&
            r.refundAmount > 0.05 * Math.max(r.sales, 1)
          )
            flags.push('REFUNDS');
          if (r.sales > 0 && r.discounts > 0.1 * (r.sales + r.discounts))
            flags.push('DISCOUNTS');
          if (r.cashShortage >= 50_000) flags.push('CASH_SHORTAGE');
          return { ...r, flags };
        })
        .sort((a, b) => b.flags.length - a.flags.length || b.sales - a.sales);
      res.json({ from: query.from, to: query.to, medians, employees: result });
    },
  );

  return router;
}
