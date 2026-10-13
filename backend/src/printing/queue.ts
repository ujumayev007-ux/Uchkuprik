import { Socket } from 'node:net';
import type { Services } from '../context.js';
import { kitchenTicket } from './escpos.js';

const MAX_ATTEMPTS = 6;
const typeLabels = {
  DINE_IN: 'Zalda',
  TAKEAWAY: 'Olib ketish',
  DELIVERY: 'Yetkazib berish',
} as const;

/** Sends raw bytes to a network printer (JetDirect/raw port 9100). */
export function sendToPrinter(
  host: string,
  port: number,
  payload: Uint8Array,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('Printer timeout')));
    socket.once('error', fail);
    socket.connect(port, host, () => {
      socket.end(payload, () => resolve());
    });
  });
}

/**
 * Queues kitchen tickets for items of a placed order that were not printed yet. Each
 * active kitchen printer of the branch receives the items of its station; printers
 * without a station receive every item. Items are marked so they print only once.
 */
export async function enqueueKitchenTickets(
  services: Services,
  orderId: string,
) {
  const { db } = services;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        table: { select: { name: true } },
        branch: { select: { timezone: true } },
        items: { where: { status: 'ACTIVE', kitchenPrintedAt: null } },
      },
    });
    if (
      !order ||
      order.status === 'DRAFT' ||
      order.status === 'CANCELLED' ||
      order.items.length === 0
    )
      return;
    const printers = await tx.printer.findMany({
      where: {
        tenantId: order.tenantId,
        branchId: order.branchId,
        kind: 'KITCHEN',
        isActive: true,
      },
      include: { station: true },
    });
    for (const printer of printers) {
      const items = order.items.filter(
        (item) =>
          !printer.stationId ||
          !item.stationId ||
          item.stationId === printer.stationId,
      );
      if (items.length === 0) continue;
      await tx.printJob.create({
        data: {
          tenantId: order.tenantId,
          printerId: printer.id,
          orderId: order.id,
          kind: 'KITCHEN',
          payload: kitchenTicket({
            stationName: printer.station?.name ?? null,
            number: order.number,
            typeLabel: typeLabels[order.type],
            table: order.table?.name ?? null,
            note: order.note,
            priority: order.priority,
            createdAt: order.placedAt ?? order.createdAt,
            timezone: order.branch.timezone,
            items: items.map((item) => ({
              quantity: item.quantity,
              name: `${item.productName}${item.variantName === 'Standart' ? '' : ` (${item.variantName})`}`,
              modifiers: [
                ...(item.modifiers as { name: string }[]).map(
                  (modifier) => modifier.name,
                ),
                // Set contents are listed for the cook.
                ...(
                  item.components as { name: string; quantity: number }[]
                ).map((part) => `${part.quantity}× ${part.name}`),
              ],
              note: item.note,
            })),
          }),
        },
      });
    }
    await tx.orderItem.updateMany({
      where: { id: { in: order.items.map((item) => item.id) } },
      data: { kitchenPrintedAt: services.now?.() ?? new Date() },
    });
  });
}

/**
 * Delivers due print jobs. Jobs are claimed with SKIP LOCKED so several API instances
 * never print the same ticket twice; failures retry with exponential backoff and end
 * as FAILED for manual retry from the recovery screen.
 */
export async function processPrintJobs(services: Services, limit = 20) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM print_jobs
      WHERE status = 'PENDING' AND "nextTryAt" <= ${now}
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    // Push nextTryAt forward while this worker owns the jobs.
    await tx.printJob.updateMany({
      where: { id: { in: ids } },
      data: { nextTryAt: new Date(now.getTime() + 60_000) },
    });
    return tx.printJob.findMany({
      where: { id: { in: ids } },
      include: { printer: true },
    });
  });
  let sent = 0;
  for (const job of claimed) {
    try {
      if (!job.printer.isActive) throw new Error('Printer disabled');
      await sendToPrinter(job.printer.host, job.printer.port, job.payload);
      await db.printJob.update({
        where: { id: job.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      sent++;
    } catch (error) {
      const attempts = job.attempts + 1;
      await db.printJob.update({
        where: { id: job.id },
        data: {
          attempts,
          lastError:
            error instanceof Error
              ? error.message.slice(0, 200)
              : 'Print failed',
          status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
          nextTryAt: new Date(Date.now() + 5000 * 2 ** (attempts - 1)),
        },
      });
    }
  }
  return { claimed: claimed.length, sent };
}

export function startPrintWorker(services: Services, intervalMs = 3000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processPrintJobs(services)
      .catch(() => services.logger.error('Print worker iteration failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
