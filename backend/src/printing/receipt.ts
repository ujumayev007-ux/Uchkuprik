import { EscPos } from './escpos.js';
import {
  columnsForWidth,
  printableDots,
  type ReceiptTemplateSettings,
} from './receipt-template.js';

/** Data of a customer receipt, already formatted by the caller where text is shown. */
export type ReceiptData = {
  business: {
    name: string;
    legalName?: string | null;
    taxId?: string | null;
    phone?: string | null;
    header?: string | null;
    footer?: string | null;
  };
  branch: { name: string; address?: string | null };
  cashier?: string | null;
  // Who opened the order when it was a waiter (null otherwise).
  waiter?: string | null;
  // The guest as taken with the order (any part may be missing).
  customer?: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  // Present only after a certified fiscal provider registered the receipt.
  fiscal?: { fiscalSign?: string | null; qrUrl?: string | null } | null;
  // 0 = the first receipt of the order; 1, 2 … = printed again ("NUSXA").
  copy?: number;
  number: number;
  dateTime: string;
  typeLabel: string;
  table?: string | null;
  items: {
    name: string;
    modifiers?: string[];
    note?: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  subtotal: number;
  discountTotal: number;
  serviceCharge: number;
  total: number;
  payments: { label: string; amount: number; change?: number | null }[];
  due: number;
};

const money = (value: number) =>
  value.toLocaleString('en-US').replace(/,/g, ' ');

/** "2026-10-25 14:05" in the branch's time zone (receipts never show UTC). */
export function localDateTime(date: Date, timeZone = 'Asia/Tashkent'): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The VAT contained in a price that includes it: total × p / (100 + p). */
export const vatIncluded = (total: number, percent: number) =>
  percent > 0 ? Math.round((total * percent) / (100 + percent)) : 0;

/** Text of a Wi-Fi QR code that phones join by scanning. */
export const wifiQrText = (name: string, password: string) => {
  const esc = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
  return password
    ? `WIFI:T:WPA;S:${esc(name)};P:${esc(password)};;`
    : `WIFI:T:nopass;S:${esc(name)};;`;
};

const SPACING_DOTS = { tight: 24, normal: 30, loose: 42 } as const;

/**
 * Customer receipt for ESC/POS printers (58 mm, 80 mm or a custom width), following a
 * template: margins, font, line spacing, visible fields and content-driven or fixed
 * length. The logo is printed as a 1-bit picture (when the designer made one) and shown
 * as the uploaded image on browser receipts.
 */
export function receiptTicket(
  data: ReceiptData,
  settings: ReceiptTemplateSettings,
): Uint8Array<ArrayBuffer> {
  const marginsMm = settings.marginLeftMm + settings.marginRightMm;
  const small = settings.fontSize === 'small';
  const baseColumns = columnsForWidth(settings.widthMm, marginsMm);
  // Font B is 9 dots wide instead of 12.
  const columns = small ? Math.floor((baseColumns * 12) / 9) : baseColumns;
  const spacing = SPACING_DOTS[settings.lineSpacing];
  let lines = 0;
  const doc = new EscPos(columns)
    .area(
      settings.marginLeftMm * 8,
      printableDots(settings.widthMm) - marginsMm * 8,
    )
    .smallFont(small)
    .lineSpacing(spacing)
    .feedDots(settings.marginTopMm * 8);
  const line = (text = '') => {
    doc.line(text);
    lines += 1;
    return doc;
  };
  const pair = (left: string, right: string) => {
    doc.pair(left, right, columns);
    lines += 1;
  };
  const rule = () => {
    let char = '-';
    if (settings.separatorStyle === 'double') char = '=';
    else if (settings.separatorStyle === 'stars') char = '*';
    else if (settings.separatorStyle === 'heavy') char = '#';
    else if (settings.separatorStyle === 'single') char = '-';
    doc.rule(char);
    lines += 1;
  };
  const big = settings.fontSize === 'large';

  if (settings.showLogo && settings.logoRaster) {
    const { w, h, data } = settings.logoRaster;
    const bytes = Buffer.from(data, 'base64');
    // Only a picture that fits the printable width is sent (never a clipped one).
    if (
      w <= printableDots(settings.widthMm) - marginsMm * 8 &&
      bytes.length === (w >> 3) * h
    ) {
      doc.align(settings.logoAlign).raster(w, h, bytes);
      // The picture does not end with a line feed: advance the paper past it.
      doc.feedDots(8);
    }
  }
  doc.align('center');
  if (settings.title) {
    doc.bold(true);
    line(settings.title);
    doc.bold(false);
  }
  if (settings.showBusinessName) {
    doc.bold(true);
    if (big) doc.size(2, 1);
    line(data.business.name);
    if (big) doc.size(1, 1);
    doc.bold(false);
  }
  if (settings.showLegalName && data.business.legalName)
    line(data.business.legalName);
  if (settings.showTaxId && data.business.taxId)
    line(`STIR: ${data.business.taxId}`);
  if (settings.showBranch) {
    line(data.branch.name);
    if (data.branch.address) line(data.branch.address);
  }
  if (settings.showPhone && data.business.phone) line(data.business.phone);
  if (data.business.header) line(data.business.header);
  if (settings.showCopyMark && (data.copy ?? 0) > 0) {
    doc.bold(true).size(2, 2);
    line('NUSXA');
    doc.size(1, 1).bold(false);
  }
  doc.align('left');
  rule();
  const bigNumber = settings.largeOrderNumber && settings.showOrderNumber;
  if (bigNumber) {
    doc.align('center').bold(true).size(2, 2);
    line(`N ${data.number}`);
    doc.size(1, 1).bold(false).align('left');
  }
  if ((settings.showOrderNumber && !bigNumber) || settings.showDateTime)
    pair(
      settings.showOrderNumber && !bigNumber ? `N ${data.number}` : '',
      settings.showDateTime ? data.dateTime : '',
    );
  if (settings.showOrderType || (settings.showTable && data.table))
    line(
      [
        settings.showOrderType ? data.typeLabel : '',
        settings.showTable && data.table ? data.table : '',
      ]
        .filter(Boolean)
        .join(' - '),
    );
  if (settings.showCashier && data.cashier) line(`Kassir: ${data.cashier}`);
  if (settings.showWaiter && data.waiter) line(`Ofitsiant: ${data.waiter}`);
  const customer = data.customer ?? {};
  if (settings.showCustomer && (customer.name || customer.phone))
    line(
      `Mijoz: ${[customer.name, customer.phone].filter(Boolean).join(', ')}`,
    );
  if (settings.showDeliveryDetails && customer.address) {
    rule();
    doc.bold(true);
    line('! YETKAZIB BERISH !');
    doc.bold(false);
    line(`Manzil: ${customer.address}`);
  }
  rule();
  for (const item of data.items) {
    pair(`${item.quantity} x ${item.name}`, money(item.lineTotal));
    if (settings.showItemUnitPrice && item.quantity > 1)
      line(`   ${money(item.unitPrice)} x ${item.quantity}`);
    if (settings.showModifiers && item.modifiers?.length)
      line(`   + ${item.modifiers.join(', ')}`);
    if (settings.showNotes && item.note) line(`   ! ${item.note}`);
  }
  if (settings.showItemCount)
    pair(
      'Taomlar soni',
      String(data.items.reduce((sum, item) => sum + item.quantity, 0)),
    );
  rule();
  if (settings.showDiscount && data.discountTotal > 0)
    pair('Chegirma', `-${money(data.discountTotal)}`);
  if (settings.showServiceCharge && data.serviceCharge > 0)
    pair('Xizmat haqi', money(data.serviceCharge));
  doc.bold(true);
  if (big) doc.size(1, 2);
  pair('JAMI', money(data.total));
  if (big) doc.size(1, 1);
  doc.bold(false);
  if (settings.showVat && settings.vatPercent > 0)
    pair(
      `Shu jumladan QQS ${settings.vatPercent}%`,
      money(vatIncluded(data.total, settings.vatPercent)),
    );
  if (settings.showPayments)
    for (const payment of data.payments) {
      pair(payment.label, money(payment.amount));
      if (settings.showChange && payment.change)
        pair('Qaytim', money(payment.change));
    }
  if (data.due > 0) {
    doc.bold(true);
    pair('QOLDI', money(data.due));
    doc.bold(false);
  }
  // Real fiscal data only: a receipt the fiscal provider has not registered shows none.
  if (settings.showFiscalData && data.fiscal?.fiscalSign) {
    rule();
    doc.align('center');
    line('FISKAL CHEK');
    if (data.business.taxId) line(`STIR: ${data.business.taxId}`);
    line(`Fiskal belgi: ${data.fiscal.fiscalSign}`);
    if (data.fiscal.qrUrl) {
      doc.qrCode(data.fiscal.qrUrl, 4);
      lines += 6;
    }
    doc.align('left');
  }
  if (settings.showSocialMedia && settings.socialMedia) {
    line(`Ijtimoiy tarmoq: ${settings.socialMedia}`);
  }
  if (settings.showWifi && settings.wifiName) {
    rule();
    doc.align('center');
    line(`Wi-Fi: ${settings.wifiName}`);
    if (settings.wifiPassword) line(`Parol: ${settings.wifiPassword}`);
    if (settings.wifiQr) {
      doc.qrCode(wifiQrText(settings.wifiName, settings.wifiPassword), 4);
      lines += 6;
    }
    doc.align('left');
  }
  if (settings.showQrCode && settings.qrContent) {
    doc.align('center');
    doc.qrCode(settings.qrContent, 4);
    lines += 6;
    if (settings.qrLabel) {
      line(settings.qrLabel);
    }
  }
  if (settings.showBarcode) {
    doc.align('center');
    const code = String(data.number).padStart(8, '0');
    doc.barcode(code, 40);
    lines += 5;
  }
  doc.align('center');
  if (settings.extraLines)
    for (const text of settings.extraLines.split('\n')) line(text);
  if (data.business.footer) line(data.business.footer);
  line(settings.thankYou);
  // Fixed length: pad to the requested length; auto: only the bottom margin.
  const usedMm = (lines * spacing) / 8 + settings.marginTopMm;
  const padMm =
    settings.lengthMode === 'fixed'
      ? Math.max(settings.marginBottomMm, settings.fixedLengthMm - usedMm)
      : settings.marginBottomMm;
  doc.feedDots(padMm * 8);
  return doc.cut().build();
}

/** Sample data for previews and test printing. */
export const sampleReceipt = (
  business = 'FAST FOOD',
  now = new Date(),
): ReceiptData => ({
  business: {
    name: business,
    legalName: '"Restoran" MChJ',
    taxId: '301234567',
    phone: '+998 90 000 00 00',
    header: null,
    footer: null,
  },
  branch: { name: 'Markaziy filial', address: 'Chilonzor, Bunyodkor 1' },
  cashier: 'Dilnoza',
  waiter: 'Ofitsiant',
  customer: { name: 'Mijoz', phone: '+998 90 000 00 00', address: null },
  number: 15,
  dateTime: localDateTime(now),
  typeLabel: 'Zalda',
  table: 'Stol 4',
  items: [
    {
      name: 'Oila seti',
      modifiers: ['Achchiq sous'],
      note: 'Piyozsiz',
      quantity: 1,
      unitPrice: 95_000,
      lineTotal: 95_000,
    },
    { name: 'Kola 0.5 L', quantity: 2, unitPrice: 10_000, lineTotal: 20_000 },
  ],
  subtotal: 115_000,
  discountTotal: 5_000,
  serviceCharge: 0,
  total: 110_000,
  payments: [{ label: 'Naqd', amount: 120_000, change: 10_000 }],
  due: 0,
});
