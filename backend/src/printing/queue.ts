import { Socket } from 'node:net';
import type { Services } from '../context.js';
import { kitchenVariantIds } from '../modules/kitchen/kitchen-filter.js';
import { loadOrderSettings } from '../modules/orders/settings.js';
import { kitchenTicket } from './escpos.js';
import { columnsForWidth } from './receipt-template.js';
import { resolveTemplate } from './resolve-template.js';
import { ticketTemplateOf } from './template.js';
import { kitchenLayoutOf } from './kitchen-design.js';
import { readOrderWorkflow } from '../modules/workflow/engine.js';
import { loadPrintRules, ruleOf } from './rules.js';

const MAX_ATTEMPTS = 6;
// Failed attempts before a copy of the ticket goes to the fallback printer.
const FALLBACK_AFTER = 2;
const typeLabels = {
  DINE_IN: 'Zalda',
  TAKEAWAY: 'Olib ketish',
  DELIVERY: 'Yetkazib berish',
} as const;

/** A send that failed after the data started to go out: the paper may have printed. */
export class PrintOutcomeUnknown extends Error {}

/** Sends raw bytes to a network printer (JetDirect/raw port 9100). */
export function sendToPrinter(
  host: string,
  port: number,
  payload: Uint8Array,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let connected = false;
    const fail = (error: Error) => {
      socket.destroy();
      reject(connected ? new PrintOutcomeUnknown(error.message) : error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('Printer timeout')));
    socket.once('error', fail);
    socket.connect(port, host, () => {
      connected = true;
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
  // Staff pressed «Oshxonaga chop etish»: rules waiting for a manual print go out too.
  options: { force?: boolean } = {},
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
    // «Fast Food» only, when the menu has that category (drinks stay off the ticket).
    const kitchenIds = order
      ? await kitchenVariantIds(tx, order.tenantId)
      : null;
    if (order && kitchenIds) {
      const allowed = new Set(kitchenIds);
      order.items = order.items.filter((item) => allowed.has(item.variantId));
    }
    if (
      !order ||
      order.status === 'DRAFT' ||
      order.status === 'PENDING' ||
      order.items.length === 0
    )
      return;
    // Workflow: tickets wait for the full payment, and a zone may send every item to
    // one kitchen station (food court, VIP kitchen).
    const flow = readOrderWorkflow(order.workflow);
    if (
      flow?.kitchenPrint === 'AFTER_PAYMENT' &&
      order.status !== 'CANCELLED' &&
      order.paidTotal - order.refundedTotal < order.total
    )
      return;
    if (flow?.stationId) {
      const stationId = flow.stationId;
      await tx.orderItem.updateMany({
        where: { orderId, kitchenPrintedAt: null, NOT: { stationId } },
        data: { stationId },
      });
      for (const item of order.items)
        if (!item.kitchenPrintedAt) item.stationId = stationId;
    }
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
    // Printing rules (Chop etish qoidalari); without a rule today's behaviour stays.
    const rules = await loadPrintRules(tx, order.tenantId);
    const changeRule = ruleOf(rules, 'MODIFICATION');
    const cancelRule = ruleOf(rules, 'CANCELLATION');
    const paid =
      order.status === 'CANCELLED' ||
      order.paidTotal - order.refundedTotal >= order.total;
    // Each printer follows the rule of its department's type (Oshxona / Kabob / Bar);
    // Kabob and Bar without their own rule follow the kitchen one.
    const ruleFor = (printer: { station: { printType: string } | null }) => {
      const type = printer.station?.printType;
      return ruleOf(
        rules,
        type === 'KEBAB' || type === 'BAR' ? type : 'KITCHEN',
      );
    };
    // Waits for a manual print, or for the full payment.
    const deferred = (rule: ReturnType<typeof ruleFor>) =>
      !options.force &&
      !!rule &&
      (rule.trigger === 'MANUAL' ||
        (rule.trigger === 'AFTER_PAYMENT' && !paid));
    // A switched-off type is marked as handled (no flood of old tickets later).
    const skipCancelled = cancelRule?.enabled === false;
    const toLine = (
      item: (typeof order.items)[number],
      showPrices: boolean,
    ) => ({
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
      ...(showPrices ? { price: item.lineTotal } : {}),
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
    // Items a printer took care of (printed, or its rule switched printing off).
    const handled = new Set<string>();
    const targeted = new Set<string>();
    for (const printer of printers) {
      const typeRule = ruleFor(printer);
      const ownItems = forPrinter(printer, fresh);
      const ownCancelled = forPrinter(printer, removed);
      for (const item of [...ownItems, ...ownCancelled]) targeted.add(item.id);
      if (deferred(typeRule)) continue;
      for (const item of [...ownItems, ...ownCancelled]) handled.add(item.id);
      const skipItems =
        (!printedBefore && typeRule?.enabled === false) ||
        (printedBefore && changeRule?.enabled === false);
      const showPrices = typeRule
        ? typeRule.showPrices
        : settings.kitchenPrices;
      const items = skipItems ? [] : ownItems;
      const cancelled = skipCancelled ? [] : ownCancelled;
      if (items.length === 0 && cancelled.length === 0) continue;
      const update = printedBefore;
      const station = ticketTemplateOf(printer.station?.ticketTemplate);
      // A named template assigned to this printer or department takes over.
      const named = await resolveTemplate(tx, order.tenantId, {
        kind: 'KITCHEN',
        printerId: printer.id,
        stationId: printer.stationId,
      });
      const custom = named.source === 'DEFAULT' ? null : named.settings;
      const layout = custom ? kitchenLayoutOf(custom, station) : station;
      const single = kitchenTicket({
        stationName: printer.station?.name ?? null,
        columns: custom
          ? columnsForWidth(
              custom.widthMm,
              custom.marginLeftMm + custom.marginRightMm,
            )
          : columnsForWidth(printer.paperWidth),
        number: order.number,
        typeLabel: typeLabels[order.type],
        table: order.table?.name ?? null,
        note: order.note,
        priority: order.priority,
        createdAt: order.placedAt ?? order.createdAt,
        timezone: order.branch.timezone,
        items: items.map((item) => toLine(item, showPrices)),
        cancelled: cancelled.map((item) => toLine(item, showPrices)),
        delivery: order.type === 'DELIVERY',
        update,
        version: order.version,
        waiter: nameOf(order.createdById),
        changedBy: update ? changedBy : null,
        changedAt: update ? (lastChange?.createdAt ?? now) : now,
        template: layout,
      });
      const rule = update ? changeRule : typeRule;
      const copies = Array.from(
        { length: rule?.copies ?? layout.copies },
        () => single,
      );
      const payload = new Uint8Array(
        copies.reduce((total, part) => total + part.length, 0),
      );
      copies.reduce((offset, part) => {
        payload.set(part, offset);
        return offset + part.length;
      }, 0);
      await tx.printJob.create({
        data: {
          tenantId: order.tenantId,
          printerId: printer.id,
          orderId: order.id,
          kind: 'KITCHEN',
          purpose: update ? 'UPDATE' : 'NEW',
          payload,
        },
      });
    }
    // Items waiting only for deferred printers stay unprinted for a later pass.
    const done = (item: { id: string }) =>
      handled.has(item.id) || !targeted.has(item.id);
    const printedNow = fresh.filter(done);
    const cancelledNow = removed.filter(done);
    if (printedNow.length)
      await tx.orderItem.updateMany({
        where: { id: { in: printedNow.map((item) => item.id) } },
        data: { kitchenPrintedAt: now },
      });
    if (cancelledNow.length)
      await tx.orderItem.updateMany({
        where: { id: { in: cancelledNow.map((item) => item.id) } },
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
  // A send interrupted by a crash or restart: it may have printed — never resent alone.
  await db.printJob.updateMany({
    where: {
      status: 'PRINTING',
      nextTryAt: { lt: new Date(now.getTime() - 60_000) },
    },
    data: {
      status: 'UNKNOWN',
      lastError: 'Natija noma’lum (ilova qayta ishga tushdi)',
    },
  });
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM print_jobs
      WHERE status = 'PENDING' AND "nextTryAt" <= ${now}
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    // Being sent now; nextTryAt marks how long this worker owns them.
    await tx.printJob.updateMany({
      where: { id: { in: ids } },
      data: { status: 'PRINTING', nextTryAt: new Date(now.getTime() + 60_000) },
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
      // It may already be on paper: no automatic retry and no fallback copy.
      if (error instanceof PrintOutcomeUnknown) {
        await db.printJob.update({
          where: { id: job.id },
          data: {
            attempts,
            status: 'UNKNOWN',
            lastError: `Natija noma’lum: ${error.message}`.slice(0, 200),
          },
        });
        continue;
      }
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
