import { EscPos } from './escpos.js';
import { localDateTime } from './receipt.js';

/**
 * Network-printer layouts of the receipt types that are not customer receipts or
 * kitchen tickets: shift report (Smena hisoboti), refund (Qaytarish cheki) and the
 * courier's delivery slip (Yetkazish cheki).
 */
const money = (value: number) =>
  value.toLocaleString('en-US').replace(/,/g, ' ');
const columnsOf = (paperWidth: number) => (paperWidth === 58 ? 32 : 48);
const METHOD: Record<string, string> = {
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
const label = (method: string) => METHOD[method] ?? method;

export function shiftReportSlip(input: {
  paperWidth: number;
  business: string;
  branch: string;
  timezone: string;
  openedAt: Date;
  closedAt: Date | null;
  openedBy: string | null;
  closedBy: string | null;
  openingCash: number;
  payments: { method: string; amount: number; count: number }[];
  refunds: { method: string; amount: number; count: number }[];
  movements: { amount: number; reason: string }[];
  ordersPaid: number;
  totalPayments: number;
  totalRefunds: number;
  expectedCash: number;
  countedCash: number | null;
  variance: number | null;
}) {
  const esc = new EscPos(columnsOf(input.paperWidth));
  esc
    .align('center')
    .bold(true)
    .line(input.business)
    .bold(false)
    .line(input.branch);
  esc.bold(true).size(2, 2).line('Z-HISOBOT').size(1, 1).bold(false);
  esc.align('left').rule();
  esc.line(`Ochildi: ${localDateTime(input.openedAt, input.timezone)}`);
  if (input.openedBy) esc.line(`  ${input.openedBy}`);
  if (input.closedAt) {
    esc.line(`Yopildi: ${localDateTime(input.closedAt, input.timezone)}`);
    if (input.closedBy) esc.line(`  ${input.closedBy}`);
  }
  esc.rule();
  esc.pair('Boshlang‘ich naqd', money(input.openingCash));
  esc.bold(true).line('To‘lovlar').bold(false);
  for (const row of input.payments)
    esc.pair(`${label(row.method)} (${row.count})`, money(row.amount));
  esc.pair('Jami to‘lovlar', money(input.totalPayments));
  if (input.refunds.length) {
    esc.bold(true).line('Qaytarishlar').bold(false);
    for (const row of input.refunds)
      esc.pair(`${label(row.method)} (${row.count})`, money(row.amount));
    esc.pair('Jami qaytarish', money(input.totalRefunds));
  }
  if (input.movements.length) {
    esc.bold(true).line('Kirim / chiqim').bold(false);
    for (const row of input.movements)
      esc.pair(
        row.reason.slice(0, 28),
        `${row.amount < 0 ? '-' : '+'}${money(Math.abs(row.amount))}`,
      );
  }
  esc.rule();
  esc.pair('Buyurtmalar', String(input.ordersPaid));
  esc.bold(true).pair('Kutilgan naqd', money(input.expectedCash)).bold(false);
  if (input.countedCash !== null)
    esc.pair('Sanalgan naqd', money(input.countedCash));
  if (input.variance !== null)
    esc.pair(
      'Farq',
      `${input.variance < 0 ? '-' : ''}${money(Math.abs(input.variance))}`,
    );
  return esc.feed(4).cut().build();
}

export function refundSlip(input: {
  paperWidth: number;
  business: string;
  branch: string;
  timezone: string;
  number: number;
  createdAt: Date;
  method: string;
  amount: number;
  reason: string;
  approvedBy: string | null;
  copy: number;
}) {
  const esc = new EscPos(columnsOf(input.paperWidth));
  esc
    .align('center')
    .bold(true)
    .line(input.business)
    .bold(false)
    .line(input.branch);
  esc.bold(true).size(2, 2).line('QAYTARISH').size(1, 1).bold(false);
  if (input.copy > 0) esc.line('NUSXA');
  esc.align('left').rule();
  esc.pair(
    `Buyurtma №${input.number}`,
    localDateTime(input.createdAt, input.timezone),
  );
  esc.pair('Usul', label(input.method));
  esc.bold(true).pair('QAYTARILDI', money(input.amount)).bold(false);
  esc.line(`Sabab: ${input.reason}`);
  if (input.approvedBy) esc.line(`Tasdiqladi: ${input.approvedBy}`);
  esc.feed(2).line('Mijoz imzosi: ______________');
  return esc.feed(4).cut().build();
}

export function deliverySlip(input: {
  paperWidth: number;
  business: string;
  timezone: string;
  number: number;
  createdAt: Date;
  customerName: string | null;
  customerPhone: string | null;
  address: string | null;
  landmark: string | null;
  note: string | null;
  items: { name: string; quantity: number }[];
  total: number;
  due: number;
  deliveryFee: number;
}) {
  const esc = new EscPos(columnsOf(input.paperWidth));
  esc.align('center').bold(true).line(input.business).bold(false);
  esc
    .bold(true)
    .size(2, 2)
    .line(`YETKAZISH №${input.number}`)
    .size(1, 1)
    .bold(false);
  esc.line(localDateTime(input.createdAt, input.timezone));
  esc.align('left').rule();
  if (input.customerName) esc.line(`Mijoz: ${input.customerName}`);
  if (input.customerPhone)
    esc.bold(true).line(`Tel: ${input.customerPhone}`).bold(false);
  if (input.address) esc.line(`Manzil: ${input.address}`);
  if (input.landmark) esc.line(`Mo‘ljal: ${input.landmark}`);
  if (input.note) esc.line(`Izoh: ${input.note}`);
  esc.rule();
  for (const item of input.items) esc.line(`${item.quantity} x ${item.name}`);
  esc.rule();
  if (input.deliveryFee > 0) esc.pair('Yetkazish', money(input.deliveryFee));
  esc.bold(true).pair('JAMI', money(input.total)).bold(false);
  esc
    .bold(true)
    .pair(input.due > 0 ? 'OLINADI' : 'TO‘LANGAN', money(input.due))
    .bold(false);
  esc.feed(2).line('Qabul qildi: ______________');
  return esc.feed(4).cut().build();
}
