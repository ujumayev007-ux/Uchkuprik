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
  doc.align('left');
  rule();
  if (settings.showOrderNumber || settings.showDateTime)
    pair(
      settings.showOrderNumber ? `N ${data.number}` : '',
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
  if (settings.showWaiter) line('Ofitsiant: Sardor');
  if (settings.showDeliveryDetails) {
    rule();
    doc.bold(true);
    line('! YETKAZIB BERISH (DOSTAVKA) !');
    doc.bold(false);
    line('Mijoz: Azizxon (+998 90 123 45 67)');
    line('Manzil: Chilonzor 9, 12-uy');
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
  if (settings.showFiscalData) {
    rule();
    line('OFD FISKAL CHEK');
    line(`STIR: ${data.business.taxId || '301234567'}`);
    line('FPU: FT0000001');
    line('Fiskal belgi: 123456789012');
  }
  if (settings.showSocialMedia && settings.socialMedia) {
    line(`Ijtimoiy tarmoq: ${settings.socialMedia}`);
  }
  if (settings.showQrCode && (settings.qrContent || data.business.phone)) {
    doc.align('center');
    const content = settings.qrContent || 'https://fastfood.uz';
    doc.qrCode(content, 4);
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
  number: 15,
  dateTime: now.toISOString().slice(0, 16).replace('T', ' '),
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
