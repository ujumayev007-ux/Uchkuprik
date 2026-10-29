import type { Services } from '../context.js';
import type { Tx } from '../db.js';
import {
  receiptBytes,
  receiptData,
  repeated,
} from '../modules/orders/receipt-data.js';
import { netPaid } from '../modules/orders/engine.js';
import { shiftSummary } from '../modules/shifts/shifts.routes.js';
import { loadPrintRules, type PrintRule, type ReceiptType } from './rules.js';
import { deliverySlip, refundSlip, shiftReportSlip } from './slips.js';

/**
 * Chop etish qoidalari with a printer: the server prints these receipt types by itself
 * (paid / credit receipt, preliminary bill, delivery slip, refund, shift report). Each
 * one is printed once — a job with its purpose marks it — and only on the printer the
 * rule names, in the order's branch.
 */

const placed = (status: string) =>
  !['DRAFT', 'PENDING', 'CANCELLED'].includes(status);

async function rulePrinter(
  tx: Tx,
  tenantId: string,
  branchId: string,
  rule: PrintRule | undefined,
) {
  if (!rule?.enabled || !rule.printerId || rule.trigger === 'MANUAL')
    return null;
  return tx.printer.findFirst({
    where: { id: rule.printerId, tenantId, branchId, isActive: true },
  });
}

async function once(
  tx: Tx,
  input: {
    tenantId: string;
    printerId: string;
    orderId: string | null;
    kind: 'RECEIPT' | 'KITCHEN';
    purpose: string;
    payload: Uint8Array<ArrayBuffer>;
  },
) {
  const done = await tx.printJob.findFirst({
    where: {
      tenantId: input.tenantId,
      purpose: input.purpose,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    select: { id: true },
  });
  if (done) return false;
  await tx.printJob.create({ data: input });
  return true;
}

/** After an order changed: the receipts its rules print automatically. */
export async function autoPrintOrder(services: Services, orderId: string) {
  const { db } = services;
  const rules = await loadPrintRules(
    db,
    (
      await db.order.findUnique({
        where: { id: orderId },
        select: { tenantId: true },
      })
    )?.tenantId ?? '00000000-0000-0000-0000-000000000000',
  );
  // Nothing to do for restaurants without printer-bound rules (the usual case).
  if (!Object.values(rules).some((rule) => rule?.printerId)) return [];
  const printed: ReceiptType[] = [];
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true, payments: true, refunds: true, table: true },
    });
    if (!order || order.status === 'CANCELLED' || order.status === 'DRAFT')
      return;
    const paid = order.total > 0 && netPaid(order) >= order.total;
    const credit = order.payments.some(
      (payment) => payment.method === 'CREDIT',
    );
    // Paid receipt (or the credit receipt the guest signs) once the order is paid.
    const paidType: ReceiptType = credit ? 'CREDIT' : 'PAID';
    const paidRule = rules[paidType] ?? rules.SALES;
    const jobs: { type: ReceiptType; rule: PrintRule; purpose: string }[] = [];
    if (paid && paidRule)
      jobs.push({ type: paidType, rule: paidRule, purpose: 'AUTO_PAID' });
    // The preliminary bill: when the order is placed (or after payment of the advance).
    const bill = rules.PRELIM_BILL;
    if (
      bill &&
      !paid &&
      placed(order.status) &&
      (bill.trigger !== 'AFTER_PAYMENT' || netPaid(order) > 0)
    )
      jobs.push({ type: 'PRELIM_BILL', rule: bill, purpose: 'AUTO_BILL' });
    for (const job of jobs) {
      const printer = await rulePrinter(
        tx,
        order.tenantId,
        order.branchId,
        job.rule,
      );
      if (!printer) continue;
      const receipt = await receiptData(tx, order, {
        printerId: printer.id,
        print: true,
      });
      const payload = repeated(receiptBytes(receipt), job.rule.copies);
      if (
        await once(tx, {
          tenantId: order.tenantId,
          printerId: printer.id,
          orderId: order.id,
          kind: 'RECEIPT',
          purpose: job.purpose,
          payload,
        })
      )
        printed.push(job.type);
    }
    // The courier's delivery slip.
    const slip = rules.DELIVERY;
    if (
      slip &&
      order.type === 'DELIVERY' &&
      placed(order.status) &&
      (slip.trigger !== 'AFTER_PAYMENT' || paid)
    ) {
      const printer = await rulePrinter(
        tx,
        order.tenantId,
        order.branchId,
        slip,
      );
      if (printer) {
        const [tenant, branch] = await Promise.all([
          tx.tenant.findUniqueOrThrow({ where: { id: order.tenantId } }),
          tx.branch.findUniqueOrThrow({
            where: { id: order.branchId },
            include: { brand: true },
          }),
        ]);
        const single = deliverySlip({
          paperWidth: printer.paperWidth,
          business: branch.brand?.name ?? tenant.name,
          timezone: branch.timezone,
          number: order.number,
          createdAt: order.createdAt,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          address: order.deliveryAddress,
          landmark: order.deliveryLandmark,
          note: order.note,
          items: order.items
            .filter((item) => item.status === 'ACTIVE')
            .map((item) => ({
              name: `${item.productName}${item.variantName === 'Standart' ? '' : ` (${item.variantName})`}`,
              quantity: item.quantity,
            })),
          total: order.total,
          due: Math.max(0, order.total - netPaid(order)),
          deliveryFee: order.deliveryFee,
        });
        if (
          await once(tx, {
            tenantId: order.tenantId,
            printerId: printer.id,
            orderId: order.id,
            kind: printer.kind,
            purpose: 'AUTO_DELIVERY',
            payload: repeated(single, slip.copies),
          })
        )
          printed.push('DELIVERY');
      }
    }
  });
  return printed;
}

/** A refund slip (Qaytarish cheki): automatically, or again by staff (copy > 0). */
export async function printRefund(
  services: Services,
  refundId: string,
  manual: { printerId: string } | null,
) {
  const { db } = services;
  return db.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: refundId } });
    if (!refund) return null;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: refund.orderId },
    });
    const rule = (await loadPrintRules(tx, refund.tenantId)).REFUND;
    if (rule?.enabled === false) return null;
    const printer = manual
      ? await tx.printer.findFirst({
          where: {
            id: manual.printerId,
            tenantId: refund.tenantId,
            isActive: true,
          },
        })
      : await rulePrinter(tx, refund.tenantId, order.branchId, rule);
    if (!printer) return null;
    const purpose = `REFUND:${refund.id}`;
    const earlier = await tx.printJob.count({
      where: { tenantId: refund.tenantId, orderId: order.id, purpose },
    });
    if (!manual && earlier > 0) return null;
    const [tenant, branch, approver] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: refund.tenantId } }),
      tx.branch.findUniqueOrThrow({ where: { id: order.branchId } }),
      tx.user.findUnique({
        where: { id: refund.approvedById },
        select: { displayName: true },
      }),
    ]);
    const single = refundSlip({
      paperWidth: printer.paperWidth,
      business: tenant.name,
      branch: branch.name,
      timezone: branch.timezone,
      number: order.number,
      createdAt: refund.createdAt,
      method: refund.method,
      amount: refund.amount,
      reason: refund.reason,
      approvedBy: approver?.displayName ?? null,
      copy: earlier,
    });
    return tx.printJob.create({
      data: {
        tenantId: refund.tenantId,
        printerId: printer.id,
        orderId: order.id,
        kind: printer.kind,
        purpose,
        payload: repeated(single, earlier === 0 ? (rule?.copies ?? 1) : 1),
      },
    });
  });
}

/** The Z report on the shift's branch printer when the shift closes. */
export async function printShiftReport(services: Services, shiftId: string) {
  const { db } = services;
  return db.$transaction(async (tx) => {
    const shift = await tx.cashShift.findUnique({ where: { id: shiftId } });
    if (!shift) return null;
    const rule = (await loadPrintRules(tx, shift.tenantId)).SHIFT_REPORT;
    const printer = await rulePrinter(tx, shift.tenantId, shift.branchId, rule);
    if (!printer) return null;
    const purpose = `SHIFT:${shift.id}`;
    if (
      await tx.printJob.count({ where: { tenantId: shift.tenantId, purpose } })
    )
      return null;
    const [summary, tenant, branch, users] = await Promise.all([
      shiftSummary(tx, shift.id),
      tx.tenant.findUniqueOrThrow({ where: { id: shift.tenantId } }),
      tx.branch.findUniqueOrThrow({ where: { id: shift.branchId } }),
      tx.user.findMany({
        where: {
          id: { in: [shift.openedById, shift.closedById ?? shift.openedById] },
        },
        select: { id: true, displayName: true },
      }),
    ]);
    const name = (id: string | null) =>
      users.find((user) => user.id === id)?.displayName ?? null;
    const single = shiftReportSlip({
      paperWidth: printer.paperWidth,
      business: tenant.name,
      branch: branch.name,
      timezone: branch.timezone,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      openedBy: name(shift.openedById),
      closedBy: name(shift.closedById),
      openingCash: shift.openingCash,
      payments: summary.payments,
      refunds: summary.refunds,
      movements: summary.movements,
      ordersPaid: summary.ordersPaid,
      totalPayments: summary.totalPayments,
      totalRefunds: summary.totalRefunds,
      expectedCash: summary.expectedCash,
      countedCash: shift.countedCash,
      variance: shift.variance,
    });
    return tx.printJob.create({
      data: {
        tenantId: shift.tenantId,
        printerId: printer.id,
        orderId: null,
        kind: printer.kind,
        purpose,
        payload: repeated(single, rule?.copies ?? 1),
      },
    });
  });
}
