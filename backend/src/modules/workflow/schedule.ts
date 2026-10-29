import type { Services } from '../../context.js';
import { addEvent } from '../orders/engine.js';
import { readOrderWorkflow } from './engine.js';

/**
 * Scheduled orders and banquets (workflows 11 and 12): an approved order waits as
 * PENDING with scheduleConfirmedAt set, and is placed — reaching the kitchen, printers
 * and screens — scheduleLeadMinutes before its time.
 */
export async function releaseDueOrders(services: Services, limit = 50) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  // The longest lead time is a day; the exact lead comes from each order's snapshot.
  const candidates = await db.order.findMany({
    where: {
      status: 'PENDING',
      scheduleConfirmedAt: { not: null },
      scheduledFor: { lte: new Date(now.getTime() + 86_400_000) },
    },
    select: { id: true, tenantId: true, scheduledFor: true, workflow: true },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  });
  const released: string[] = [];
  for (const candidate of candidates) {
    const flow = readOrderWorkflow(candidate.workflow);
    const lead = (flow?.scheduleLeadMinutes ?? 0) * 60_000;
    if (candidate.scheduledFor!.getTime() - lead > now.getTime()) continue;
    if (
      await releaseOrder(
        services,
        candidate.tenantId,
        candidate.id,
        null,
        'schedule',
      )
    )
      released.push(candidate.id);
  }
  return released;
}

/** Places a confirmed scheduled order now (on time, or early by staff). */
export async function releaseOrder(
  services: Services,
  tenantId: string,
  orderId: string,
  actorId: string | null,
  source: 'schedule' | 'manual',
) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const order = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const current = await tx.order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (
      !current ||
      current.status !== 'PENDING' ||
      !current.scheduleConfirmedAt
    )
      return null;
    const flow = readOrderWorkflow(current.workflow);
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'PLACED',
        placedAt: now,
        ...(flow && !flow.kitchenConfirm ? { kitchenAcceptedAt: now } : {}),
        version: { increment: 1 },
      },
    });
    await addEvent(tx, tenantId, orderId, actorId, 'status', {
      from: 'PENDING',
      to: 'PLACED',
      source,
    });
    return updated;
  });
  if (!order) return false;
  await services.afterOrderChange?.(order.id);
  services.events?.publish({
    type: 'order.changed',
    tenantId: order.tenantId,
    branchId: order.branchId,
    orderId: order.id,
    number: order.number,
    status: order.status,
  });
  return true;
}

export function startScheduleWorker(services: Services, intervalMs = 30_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    releaseDueOrders(services)
      .catch(() => services.logger.error('Scheduled order release failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
