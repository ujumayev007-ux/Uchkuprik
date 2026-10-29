import { z } from 'zod';
import type { Db, Tx } from '../db.js';
import { EscPos } from './escpos.js';

/**
 * Printing rules per receipt type (Owner → Printer boshqaruvi → Chop etish qoidalari,
 * or the restaurant Admin). Missing rules keep today's behaviour, so restaurants
 * without rules print exactly as before.
 */
export const RECEIPT_TYPES = [
  'SALES',
  'KITCHEN',
  'KEBAB',
  'BAR',
  'PRELIM_BILL',
  'PAID',
  'MODIFICATION',
  'CANCELLATION',
  'DELIVERY',
  'SHIFT_REPORT',
  'CREDIT',
  'REFUND',
] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

// Types whose rules the server applies today; the others are kept for the printers
// and screens that use them.
export const ENFORCED_TYPES: ReceiptType[] = [
  'KITCHEN',
  'MODIFICATION',
  'CANCELLATION',
  'PAID',
];

export const ruleSchema = z.object({
  enabled: z.boolean().default(true),
  copies: z.number().int().min(1).max(5).default(1),
  trigger: z
    .enum(['AUTO', 'MANUAL', 'AFTER_APPROVAL', 'AFTER_PAYMENT'])
    .default('AUTO'),
  // Kitchen tickets hide selling prices unless switched on.
  showPrices: z.boolean().default(false),
});
export type PrintRule = z.infer<typeof ruleSchema>;
export const printRulesSchema = z.partialRecord(z.enum(RECEIPT_TYPES), ruleSchema);
export type PrintRules = z.infer<typeof printRulesSchema>;

export async function loadPrintRules(db: Db | Tx, tenantId: string): Promise<PrintRules> {
  const profile = await db.tenantProfile.findUnique({
    where: { tenantId },
    select: { printRules: true },
  });
  const parsed = printRulesSchema.safeParse(profile?.printRules ?? {});
  return parsed.success ? parsed.data : {};
}

/** A rule only when the restaurant set one (otherwise today's behaviour). */
export const ruleOf = (rules: PrintRules, type: ReceiptType): PrintRule | null =>
  rules[type] ?? null;

/** The same test page as the printer screen's "Sinov" button. */
export function testPage(printer: {
  name: string;
  kind: string;
  host: string;
  port: number;
  paperWidth: number;
  station?: { name: string } | null;
}) {
  const esc = new EscPos(printer.paperWidth === 58 ? 32 : 48)
    .align('center')
    .bold(true)
    .line('FAST FOOD — SINOV CHEKI')
    .bold(false)
    .line(`Printer: ${printer.name}`)
    .line(
      `Bo‘lim: ${printer.station?.name ?? (printer.kind === 'RECEIPT' ? 'Kassa' : 'Umumiy oshxona')}`,
    )
    .line(`IP: ${printer.host}:${printer.port}`)
    .line(`Kenglik: ${printer.paperWidth} mm`)
    .line(new Date().toISOString().slice(0, 16).replace('T', ' '));
  if (printer.kind === 'RECEIPT') esc.cashDrawer(2);
  return esc.feed(4).cut().build();
}
