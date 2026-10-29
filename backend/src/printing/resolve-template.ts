import type { Db, Tx } from '../db.js';
import {
  fromLegacyLayout,
  templateSettingsOf,
  type ReceiptTemplateSettings,
  type TemplateKind,
} from './receipt-template.js';

/**
 * Template that applies to a print target: the printer's own template, else the one
 * for this customer receipt type (bill / paid / credit), else its department's, else
 * the default of the receipt kind, else (customer receipts) the restaurant's original
 * single layout.
 */
export async function resolveTemplate(
  db: Db | Tx,
  tenantId: string,
  input: {
    kind: TemplateKind;
    printerId?: string | null;
    stationId?: string | null;
    templateId?: string | null;
    receiptType?: string | null;
  },
): Promise<{
  settings: ReceiptTemplateSettings;
  source: string;
  id: string | null;
}> {
  if (input.templateId) {
    const picked = await db.receiptTemplate.findFirst({
      where: { id: input.templateId, tenantId },
    });
    if (picked)
      return {
        settings: templateSettingsOf(picked.settings),
        source: 'TEMPLATE',
        id: picked.id,
      };
  }
  const targets = [
    input.printerId && { targetType: 'PRINTER', targetId: input.printerId },
    input.receiptType && {
      targetType: 'RECEIPT_TYPE',
      targetId: input.receiptType,
    },
    input.stationId && { targetType: 'STATION', targetId: input.stationId },
    { targetType: 'TYPE', targetId: input.kind },
  ].filter(Boolean) as { targetType: string; targetId: string }[];
  const rows = await db.receiptAssignment.findMany({
    where: { tenantId, OR: targets },
    include: { template: true },
  });
  for (const target of targets) {
    const hit = rows.find(
      (row) =>
        row.targetType === target.targetType &&
        row.targetId === target.targetId,
    );
    if (hit)
      return {
        settings: templateSettingsOf(hit.template.settings),
        source: hit.targetType,
        id: hit.templateId,
      };
  }
  if (input.kind === 'CUSTOMER') {
    const profile = await db.tenantProfile.findUnique({
      where: { tenantId },
      select: { receiptSettings: true },
    });
    return {
      settings: fromLegacyLayout(profile?.receiptSettings),
      source: 'DEFAULT',
      id: null,
    };
  }
  return { settings: templateSettingsOf({}), source: 'DEFAULT', id: null };
}
