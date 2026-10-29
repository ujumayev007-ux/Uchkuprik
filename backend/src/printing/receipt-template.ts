import { z } from 'zod';

/**
 * Receipt / ticket templates. One schema describes paper, text and field
 * visibility for customer receipts and kitchen tickets. The restaurant keeps the
 * old single layout (TenantProfile.receiptSettings) as its default template and can
 * add any number of named templates, assigned to a printer, a department (kitchen
 * station) or a receipt type.
 */

export const TEMPLATE_KINDS = ['CUSTOMER', 'KITCHEN'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const ASSIGNMENT_TARGETS = ['PRINTER', 'STATION', 'TYPE'] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

const dataImage = z
  .string()
  .max(260_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
  .or(z.literal(''));

export const receiptTemplateSchema = z.object({
  // Paper width in millimetres: 58 and 80 are the common sizes, others are custom.
  widthMm: z.number().int().min(40).max(112).default(80),
  fontSize: z.enum(['small', 'normal', 'large']).default('normal'),
  lineSpacing: z.enum(['tight', 'normal', 'loose']).default('normal'),
  marginLeftMm: z.number().int().min(0).max(15).default(2),
  marginRightMm: z.number().int().min(0).max(15).default(2),
  marginTopMm: z.number().int().min(0).max(30).default(2),
  marginBottomMm: z.number().int().min(0).max(40).default(8),
  // "auto": the length follows the content; "fixed": at least fixedLengthMm.
  lengthMode: z.enum(['auto', 'fixed']).default('auto'),
  fixedLengthMm: z.number().int().min(50).max(800).default(200),
  showLogo: z.boolean().default(false),
  logo: dataImage.default(''),
  logoWidthPct: z.number().int().min(10).max(100).default(60),
  logoAlign: z.enum(['left', 'center', 'right']).default('center'),
  // The logo as a 1-bit picture for thermal printers, made by the designer at the
  // chosen size (width is a multiple of 8 dots, 1 bit per dot, black = 1).
  logoRaster: z
    .object({
      w: z.number().int().min(8).max(832).multipleOf(8),
      h: z.number().int().min(1).max(400),
      data: z
        .string()
        .max(48_000)
        .regex(/^[A-Za-z0-9+/=]+$/),
    })
    .nullable()
    .default(null),
  showBusinessName: z.boolean().default(true),
  showLegalName: z.boolean().default(true),
  showTaxId: z.boolean().default(true),
  showBranch: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  showCashier: z.boolean().default(true),
  showWaiter: z.boolean().default(true),
  showOrderNumber: z.boolean().default(true),
  showDateTime: z.boolean().default(true),
  showOrderType: z.boolean().default(true),
  showTable: z.boolean().default(true),
  showModifiers: z.boolean().default(true),
  showItemUnitPrice: z.boolean().default(true),
  showNotes: z.boolean().default(true),
  showDiscount: z.boolean().default(true),
  showServiceCharge: z.boolean().default(true),
  showPayments: z.boolean().default(true),
  showChange: z.boolean().default(true),
  // Kitchen tickets: items in double-height letters.
  largeItems: z.boolean().default(true),
  title: z.string().trim().max(60).default(''),
  extraLines: z.string().trim().max(500).default(''),
  thankYou: z.string().trim().max(120).default('Xaridingiz uchun rahmat!'),
  separatorStyle: z
    .enum(['single', 'dashed', 'double', 'stars', 'heavy'])
    .default('dashed'),
  showQrCode: z.boolean().default(false),
  qrContent: z.string().trim().max(300).default(''),
  qrLabel: z.string().trim().max(100).default(''),
  showBarcode: z.boolean().default(false),
  showFiscalData: z.boolean().default(false),
  showDeliveryDetails: z.boolean().default(false),
  showSocialMedia: z.boolean().default(false),
  socialMedia: z.string().trim().max(100).default(''),
  // Fast food: the order number in big letters, for calling the guest at the counter.
  largeOrderNumber: z.boolean().default(false),
  // The guest's name, phone and (for delivery) address taken with the order.
  showCustomer: z.boolean().default(true),
  // "Taomlar soni: N" under the items.
  showItemCount: z.boolean().default(false),
  // "Shu jumladan QQS 12%: N" (the VAT contained in the total).
  showVat: z.boolean().default(false),
  vatPercent: z.number().min(0).max(30).default(12),
  // Guest Wi-Fi, optionally as a QR code phones join by scanning.
  showWifi: z.boolean().default(false),
  wifiName: z.string().trim().max(60).default(''),
  wifiPassword: z.string().trim().max(60).default(''),
  wifiQr: z.boolean().default(false),
  // "NUSXA" on every receipt printed again for the same order (anti-fraud).
  showCopyMark: z.boolean().default(true),
  presetKey: z.string().optional(),
  sectionOrder: z.array(z.string()).optional(),
  // Order of the receipt parts (logo, header, meta, delivery, items, totals, fiscal,
  // wifi, qr, barcode, footer). Absent: the usual order.
  layoutOrder: z.array(z.string().max(20)).max(20).optional(),
  // Browser printing on an office printer: A4/A5 page instead of the paper roll.
  pageSize: z.enum(['roll', 'A4', 'A5']).optional(),
});
export type ReceiptTemplateSettings = z.infer<typeof receiptTemplateSchema>;

export function templateSettingsOf(value: unknown): ReceiptTemplateSettings {
  const parsed = receiptTemplateSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : receiptTemplateSchema.parse({});
}

/** The pre-template layout (paper '58'|'80' …) read as a template. */
export function fromLegacyLayout(value: unknown): ReceiptTemplateSettings {
  const legacy = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Record<string, unknown>;
  const { paperWidth, ...rest } = legacy;
  return templateSettingsOf({
    ...rest,
    widthMm:
      typeof rest.widthMm === 'number'
        ? rest.widthMm
        : paperWidth === '58'
          ? 58
          : 80,
  });
}

/** Printable dots per line (8 dots per mm); thermal printers keep ~5-10 mm unprintable. */
export const printableDots = (widthMm: number) =>
  Math.max(160, (widthMm - (widthMm <= 60 ? 10 : 8)) * 8);

/** Characters per line in the printer's standard font (12 dots wide): 58 → 32, 80 → 48. */
export function columnsForWidth(widthMm: number, marginsMm = 0): number {
  return Math.max(
    16,
    Math.floor((printableDots(widthMm) - marginsMm * 8) / 12),
  );
}
