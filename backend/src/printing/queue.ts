import { Socket } from 'node:net';
import type { Services } from '../context.js';
import { loadOrderSettings } from '../modules/orders/settings.js';
import { kitchenTicket } from './escpos.js';

const MAX_ATTEMPTS = 6;
// Failed attempts before a copy of the ticket goes to the fallback printer.
const FALLBACK_AFTER = 2;
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
 * Queues kitchen tickets for a placed order: new items that were not printed yet and
 * items cancelled after they were printed ("DIQQAT! CHEK YANGILANDI"). Each active
 * kitchen printer of the branch receives the items of its station; printers without
 * a station receive every item. Items are marked inside the same transaction, so a
 * ticket is queued exactly once even when several panels trigger printing at once.
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
        items: {
          where: {
            OR: [
              { status: 'ACTIVE', kitchenPrintedAt: null },
              {
                status: 'CANCELLED',
                kitchenPrintedAt: { not: null },
                cancelPrintedAt: null,
              },
            ],
          },
        },
      },
    });
    if (
      !order ||
      order.status === 'DRAFT' ||
      order.status === 'PENDING' ||
      order.items.length === 0
    )
      return;
    const fresh =
      order.status === 'CANCELLED'
        ? []
        : order.items.filter((item) => item.status === 'ACTIVE');
    // A cancelled order still tells the kitchen to stop (all printed items removed).
    const removed = order.items.filter((item) => item.status === 'CANCELLED');
    if (order.status === 'CANCELLED' && removed.length === 0) return;
    const printedBefore =
      removed.length > 0 ||
      (await tx.orderItem.count({
        where: { orderId, kitchenPrintedAt: { not: null } },
      })) > 0;
    const settings = await loadOrderSettings(tx, order.tenantId);
    const people = await tx.user.findMany({
      where: {
        tenantId: order.tenantId,
        id: {
          in: [
            order.createdById,
            ...order.items.map((item) => item.createdById),
          ].filter((id): id is string => !!id),
        },
      },
      select: { id: true, displayName: true },
    });
    const nameOf = (id: string | null) =>
      people.find((person) => person.id === id)?.displayName ?? null;
    const lastChange = await tx.orderEvent.findFirst({
      where: { orderId },
      orderBy: { id: 'desc' },
      select: { actorId: true, createdAt: true },
    });
    const changedBy =
      lastChange?.actorId &&
      !people.some((person) => person.id === lastChange.actorId)
        ? ((
            await tx.user.findFirst({
              where: { id: lastChange.actorId, tenantId: order.tenantId },
              select: { displayName: true },
            })
          )?.displayName ?? null)
        : nameOf(lastChange?.actorId ?? null);
    const toLine = (item: (typeof order.items)[number]) => ({
      quantity: item.quantity,
      name: `${item.productName}${item.variantName === 'Standart' ? '' : ` (${item.variantName})`}`,
      modifiers: [
        ...(item.modifiers as { name: string }[]).map(
          (modifier) => modifier.name,
        ),
        // Set contents are listed for the cook.
        ...(item.components as { name: string; quantity: number }[]).map(
          (part) => `${part.quantity}× ${part.name}`,
        ),
      ],
      note: item.note,
      ...(settings.kitchenPrices ? { price: item.lineTotal } : {}),
    });
    const printers = await tx.printer.findMany({
      where: {
        tenantId: order.tenantId,
        branchId: order.branchId,
        kind: 'KITCHEN',
        isActive: true,
      },
      include: { station: true },
    });
    const forPrinter = (
      printer: (typeof printers)[number],
      items: typeof order.items,
    ) =>
      items.filter(
        (item) =>
          !printer.stationId ||
          !item.stationId ||
          item.stationId === printer.stationId,
      );
    const now = services.now?.() ?? new Date();
    for (const printer of printers) {
      const items = forPrinter(printer, fresh);
      const cancelled = forPrinter(printer, removed);
      if (items.length === 0 && cancelled.length === 0) continue;
      const update = printedBefore;
      await tx.printJob.create({
        data: {
          tenantId: order.tenantId,
          printerId: printer.id,
          orderId: order.id,
          kind: 'KITCHEN',
          purpose: update ? 'UPDATE' : 'NEW',
          payload: kitchenTicket({
            stationName: printer.station?.name ?? null,
            columns: printer.paperWidth === 58 ? 32 : 48,
            number: order.number,
            typeLabel: typeLabels[order.type],
            table: order.table?.name ?? null,
            note: order.note,
            priority: order.priority,
            createdAt: order.placedAt ?? order.createdAt,
            timezone: order.branch.timezone,
            items: items.map(toLine),
            cancelled: cancelled.map(toLine),
            delivery: order.type === 'DELIVERY',
            update,
            version: order.version,
            waiter: nameOf(order.createdById),
            changedBy: update ? changedBy : null,
            changedAt: update ? (lastChange?.createdAt ?? now) : now,
          }),
        },
      });
    }
    if (fresh.length)
      await tx.orderItem.updateMany({
        where: { id: { in: fresh.map((item) => item.id) } },
        data: { kitchenPrintedAt: now },
      });
    if (removed.length)
      await tx.orderItem.updateMany({
        where: { id: { in: removed.map((item) => item.id) } },
        data: { cancelPrintedAt: now },
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
      if (
        attempts === FALLBACK_AFTER &&
        job.printer.fallbackPrinterId &&
        !job.fallbackFromId
      ) {
        const fallback = await db.printer.findFirst({
          where: {
            id: job.printer.fallbackPrinterId,
            tenantId: job.tenantId,
            isActive: true,
          },
        });
        if (fallback)
          await db.printJob.create({
            data: {
              tenantId: job.tenantId,
              printerId: fallback.id,
              orderId: job.orderId,
              kind: job.kind,
              purpose: job.purpose,
              payload: job.payload,
              fallbackFromId: job.id,
            },
          });
      }
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
