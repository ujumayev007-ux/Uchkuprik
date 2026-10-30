import type { Db, Tx } from '../../db.js';
import { localDateTime, receiptTicket } from '../../printing/receipt.js';
import { resolveTemplate } from '../../printing/resolve-template.js';
import type { ReceiptType } from '../../printing/rules.js';
import { accountLabel } from '../credit/ledger.js';
import { serialize, type OrderWithRelations } from './serialize.js';

const typeLabels = {
  DINE_IN: 'Zalda',
  TAKEAWAY: 'Olib ketish',
  DELIVERY: 'Yetkazib berish',
} as const;
export const methodLabels: Record<string, string> = {
  CASH: 'Naqd',
  CARD: 'Karta',
  LOYALTY: 'Bonus',
  CLICK: 'Click',
  PAYME: 'Payme',
  UZUM: 'Uzum',
  QR: 'QR',
  OTHER: 'Boshqa',
  CREDIT: 'Qarzga',
};
// Receipt data never shows costs.
const noCost = {
  permissions: new Set<string>(),
  financial: { cost: false },
  reportFields: { cost: false },
} as Parameters<typeof serialize>[1];

/**
 * Which printing rule a customer receipt follows: before payment the preliminary bill,
 * after it the paid receipt, or the credit receipt the guest signs.
 */
export function customerReceiptType(order: {
  total: number;
  due: number;
  payments: { method: string }[];
}): ReceiptType {
  if (order.due > 0) return 'PRELIM_BILL';
  return order.payments.some((payment) => payment.method === 'CREDIT')
    ? 'CREDIT'
    : 'PAID';
}

/**
 * Everything a customer receipt shows (the browser page, the Kassa application and the
 * network printers use the same data). The caller has checked the order's branch.
 */
export async function receiptData(
  db: Db | Tx,
  order: OrderWithRelations,
  pick: {
    printerId?: string | null | undefined;
    templateId?: string | null | undefined;
    // A receipt really being printed (not a preview): counted for the "NUSXA" mark.
    print?: boolean | undefined;
  },
) {
  const tenantId = order.tenantId;
  const lastPayment = await db.payment.findFirst({
    where: { tenantId, orderId: order.id },
    orderBy: { createdAt: 'desc' },
    select: { createdById: true },
  });
  const [tenant, branch, creator, payer] = await Promise.all([
    db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { profile: true },
    }),
    db.branch.findUniqueOrThrow({
      where: { id: order.branchId },
      include: { brand: true },
    }),
    order.createdById
      ? db.user.findUnique({
          where: { id: order.createdById },
          select: {
            displayName: true,
            roles: { select: { role: { select: { systemKey: true } } } },
          },
        })
      : null,
    lastPayment?.createdById
      ? db.user.findUnique({
          where: { id: lastPayment.createdById },
          select: { displayName: true },
        })
      : null,
  ]);
  // The cashier is who took the payment; the waiter is who opened a waiter's order.
  const waiter = creator?.roles.some((r) => r.role.systemKey === 'waiter')
    ? creator.displayName
    : null;
  // A waiter's unpaid order has no cashier yet (the waiter is not shown as one).
  const cashier = payer ?? (waiter ? null : creator);
  // 0 = the first receipt; 1, 2 … = copies printed again ("NUSXA").
  const copy = pick.print
    ? (
        await db.order.update({
          where: { id: order.id },
          data: { receiptPrints: { increment: 1 } },
          select: { receiptPrints: true },
        })
      ).receiptPrints - 1
    : 0;
  const data = serialize(order, noCost);
  const receiptType = customerReceiptType(data);
  // Credit (nasiya) / hotel room charges name the account the guest signs for.
  const creditPayments = order.payments.filter(
    (payment) => payment.method === 'CREDIT',
  );
  const charges = creditPayments.length
    ? await db.creditEntry.findMany({
        where: {
          tenantId,
          paymentId: { in: creditPayments.map((payment) => payment.id) },
          type: 'CHARGE',
        },
        include: { account: true },
      })
    : [];
  const refunded = order.refunds
    .filter((refund) => creditPayments.some((p) => p.id === refund.paymentId))
    .reduce((sum, refund) => sum + refund.amount, 0);
  const credit = charges.length
    ? {
        account: [...new Set(charges.map((c) => accountLabel(c.account)))].join(
          ', ',
        ),
        amount: charges.reduce((sum, c) => sum + c.amount, 0) - refunded,
      }
    : null;
  return {
    // A branch trading under a brand prints the brand name and texts.
    business: {
      name: branch.brand?.name ?? tenant.name,
      brand: branch.brand
        ? {
            logoUrl: branch.brand.logoUrl,
            primaryColor: branch.brand.primaryColor,
          }
        : null,
      legalName: tenant.profile?.legalName ?? null,
      taxId: tenant.profile?.taxId ?? null,
      phone: tenant.profile?.phone ?? null,
      header:
        branch.brand?.receiptHeader ?? tenant.profile?.receiptHeader ?? null,
      footer:
        branch.brand?.receiptFooter ?? tenant.profile?.receiptFooter ?? null,
    },
    branch: {
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      timezone: branch.timezone,
    },
    cashier: cashier?.displayName ?? null,
    waiter,
    copy,
    credit,
    // Which printing rule applies (Chop etish qoidalari).
    receiptType,
    // Template of the printer (or the one picked), else the restaurant default.
    layout: (
      await resolveTemplate(db, tenantId, {
        kind: 'CUSTOMER',
        printerId: pick.printerId ?? null,
        templateId: pick.templateId ?? null,
        receiptType,
      })
    ).settings,
    // Fiscal sign/QR exist only after a certified fiscal provider registers the receipt.
    fiscal: (await db.fiscalReceipt.findUnique({
      where: { orderId: order.id },
      select: { status: true, fiscalSign: true, qrUrl: true },
    })) ?? { status: 'NOT_CONFIGURED', fiscalSign: null, qrUrl: null },
    order: {
      ...data,
      items: data.items.filter((item) => item.status === 'ACTIVE'),
    },
  };
}
export type ReceiptDataResult = Awaited<ReturnType<typeof receiptData>>;

/** ESC/POS bytes of the customer receipt, laid out by its template. */
export function receiptBytes(receipt: ReceiptDataResult) {
  const order = receipt.order;
  return receiptTicket(
    {
      business: receipt.business,
      branch: receipt.branch,
      cashier: receipt.cashier,
      waiter: receipt.waiter,
      customer: {
        name: order.customerName,
        phone: order.customerPhone,
        address: order.deliveryAddress,
      },
      fiscal: receipt.fiscal,
      copy: receipt.copy,
      number: order.number,
      // The branch's local time (not UTC).
      dateTime: localDateTime(
        new Date(order.createdAt),
        receipt.branch.timezone,
      ),
      typeLabel: typeLabels[order.type],
      table: order.table?.name ?? null,
      items: order.items.map((item) => ({
        name: `${item.productName}${
          item.variantName === 'Standart' ? '' : ` (${item.variantName})`
        }`,
        modifiers: (item.modifiers as { name: string }[]).map(
          (modifier) => modifier.name,
        ),
        note: item.note,
        quantity: item.quantity,
        unitPrice: item.unitPrice + item.modifiersTotal,
        lineTotal: item.lineTotal,
      })),
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      serviceCharge: order.serviceCharge,
      total: order.total,
      payments: order.payments.map((payment) => ({
        label: methodLabels[payment.method] ?? payment.method,
        amount: payment.tendered ?? payment.amount,
        change: payment.change,
      })),
      due: order.due,
      credit: receipt.credit,
    },
    receipt.layout,
  );
}

/** The same bytes printed several times in one job (copies of a rule). */
export function repeated(
  single: Uint8Array<ArrayBuffer>,
  copies: number,
): Uint8Array<ArrayBuffer> {
  if (copies <= 1) return single;
  const joined = new Uint8Array(single.length * copies);
  for (let i = 0; i < copies; i++) joined.set(single, i * single.length);
  return joined;
}
