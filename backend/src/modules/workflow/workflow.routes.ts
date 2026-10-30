import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { addEvent, lockOrder } from '../orders/engine.js';
import { assertSchedule, loadWorkflow, orderFlow } from './restaurant.js';
import { releaseOrder } from './schedule.js';
import { canApprove } from './engine.js';

const assertMayApprove = (
  order: { workflow?: unknown },
  permissions: Set<string>,
) => {
  if (!canApprove(orderFlow(order), permissions))
    throw new AppError(403, 'WORKFLOW_APPROVAL', 'workflowApproval');
};

/**
 * The restaurant's side of the active workflow for staff screens: what each zone
 * allows (credit, scheduling), and the scheduled orders / banquets waiting for their
 * time.
 */
export function restaurantWorkflowRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();

  router.get('/workflow/active', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    const active = await loadWorkflow(db, auth.tenantId);
    if (!active?.config.enabled) {
      res.json({ enabled: false, preset: null, zones: {} });
      return;
    }
    res.json({
      enabled: true,
      version: active.version,
      preset: active.config.preset,
      zones: Object.fromEntries(
        Object.entries(active.config.zones).map(([zone, flow]) => [
          zone,
          {
            payment: flow.payment,
            advancePercent: flow.advancePercent,
            approval: flow.approval,
            scheduling: flow.scheduling,
            scheduleLeadMinutes: flow.scheduleLeadMinutes,
          },
        ]),
      ),
    });
  });

  // Banketlar va rejalashtirilgan buyurtmalar: everything with a time still ahead or
  // released today.
  router.get(
    '/scheduled-orders',
    requireAuth(),
    requirePermission('orders.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const { branchId } = parse(
        z.object({ branchId: z.uuid().optional() }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, branchId);
      const orders = await db.order.findMany({
        where: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          scheduledFor: {
            not: null,
            gte: new Date(now().getTime() - 12 * 3_600_000),
          },
          status: { notIn: ['CANCELLED', 'COMPLETED'] },
        },
        orderBy: { scheduledFor: 'asc' },
        take: 300,
        include: { table: { select: { name: true } } },
      });
      res.json({
        orders: orders.map((order) => ({
          id: order.id,
          number: order.number,
          type: order.type,
          channel: order.channel,
          status: order.status,
          scheduledFor: order.scheduledFor,
          confirmed: !!order.scheduleConfirmedAt,
          guests: order.guests,
          eventName: order.eventName,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          table: order.table?.name ?? null,
          total: order.total,
          paid: order.paidTotal - order.refundedTotal,
          leadMinutes: orderFlow(order)?.scheduleLeadMinutes ?? 0,
        })),
      });
    },
  );

  // Change the time, guests or event name while the order has not reached the kitchen.
  router.post(
    '/orders/:id/schedule',
    requireAuth(),
    requirePermission('orders.edit'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          scheduledFor: z.iso.datetime({ offset: true }).nullable(),
          guests: z.number().int().min(1).max(5000).nullable().optional(),
          eventName: z.string().trim().max(120).nullable().optional(),
        }),
        req.body,
      );
      const order = await db.$transaction(async (tx) => {
        const order = await lockOrder(tx, auth.tenantId, id);
        await resolveBranch(tx, auth, order.branchId);
        if (order.status !== 'DRAFT' && order.status !== 'PENDING')
          throw new AppError(409, 'ORDER_CLOSED', 'orderClosed');
        // An approved booking is moved only by those who may approve it.
        if (order.scheduleConfirmedAt)
          assertMayApprove(order, auth.permissions);
        const scheduledFor = input.scheduledFor
          ? new Date(input.scheduledFor)
          : null;
        assertSchedule(orderFlow(order), scheduledFor, now());
        const updated = await tx.order.update({
          where: { id },
          data: {
            scheduledFor,
            ...(input.guests !== undefined ? { guests: input.guests } : {}),
            ...(input.eventName !== undefined
              ? { eventName: input.eventName }
              : {}),
            version: { increment: 1 },
          },
        });
        await addEvent(tx, auth.tenantId, id, auth.userId, 'schedule', {
          from: order.scheduledFor,
          to: scheduledFor,
          guests: updated.guests,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: order.branchId,
          actorUserId: auth.userId,
          action: 'order.schedule',
          entityType: 'order',
          entityId: id,
          data: {
            from: order.scheduledFor,
            to: scheduledFor,
            guests: updated.guests,
          },
        });
        return updated;
      });
      // Moved to now (or the time was removed): a confirmed order goes out right away.
      if (order.status === 'PENDING' && order.scheduleConfirmedAt) {
        const lead = (orderFlow(order)?.scheduleLeadMinutes ?? 0) * 60_000;
        if (
          !order.scheduledFor ||
          order.scheduledFor.getTime() - lead <= now().getTime()
        )
          await releaseOrder(
            services,
            auth.tenantId,
            id,
            auth.userId,
            'manual',
          );
      }
      res.json({ ok: true });
    },
  );

  // Send a confirmed scheduled order to the kitchen before its time.
  router.post(
    '/orders/:id/release',
    requireAuth(),
    requireAnyPermission('orders.approve', 'payments.accept'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const order = await db.order.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!order) throw errors.notFound();
      await resolveBranch(db, auth, order.branchId);
      // Sending a booking early is the approver's decision (e.g. Admin for banquets).
      assertMayApprove(order, auth.permissions);
      if (
        !(await releaseOrder(
          services,
          auth.tenantId,
          id,
          auth.userId,
          'manual',
        ))
      )
        throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition');
      await audit(db, req, {
        tenantId: auth.tenantId,
        branchId: order.branchId,
        actorUserId: auth.userId,
        action: 'order.release',
        entityType: 'order',
        entityId: id,
        data: { scheduledFor: order.scheduledFor },
      });
      res.json({ ok: true });
    },
  );

  return router;
}
