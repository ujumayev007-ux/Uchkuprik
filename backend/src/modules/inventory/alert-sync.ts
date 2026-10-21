import type { Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

export type Severity = 'LOW' | 'CRITICAL' | 'OUT';
const rank: Record<Severity, number> = { LOW: 1, CRITICAL: 2, OUT: 3 };

export const defaultAlertSettings = {
  enabled: true,
  soundEnabled: true,
  criticalPercent: 50,
  reminderMinutes: 10,
};

/** null = enough stock. A minimum of 0 means the item is not watched. */
export function classify(
  quantity: Decimal,
  minimum: Decimal,
  criticalPercent: number,
): Severity | null {
  if (!minimum.isPositive()) return null;
  if (quantity.lessThanOrEqualTo(0)) return 'OUT';
  if (!quantity.lessThan(minimum)) return null;
  return quantity.lessThan(minimum.times(criticalPercent).dividedBy(100))
    ? 'CRITICAL'
    : 'LOW';
}

/**
 * Raises, escalates or resolves the item's alert from the new authoritative balance.
 * Called inside the ledger transaction that holds the balance row lock, so concurrent
 * orders and receipts see each other's result and an item has at most one active alert
 * (also enforced by a partial unique index). A worse level re-opens an acknowledged
 * alert; replenishing resolves it, so the next shortage alerts again.
 */
export async function syncStockAlert(
  tx: Tx,
  ref: { tenantId: string; warehouseId: string; stockItemId: string },
  quantity: Decimal,
) {
  const [item, settings, active] = await Promise.all([
    tx.stockItem.findUnique({
      where: { id: ref.stockItemId },
      select: { minStock: true, isActive: true },
    }),
    tx.stockAlertSettings.findUnique({ where: { tenantId: ref.tenantId } }),
    tx.stockAlert.findFirst({
      where: {
        warehouseId: ref.warehouseId,
        stockItemId: ref.stockItemId,
        status: { not: 'RESOLVED' },
      },
    }),
  ]);
  if (!item) return;
  const config = { ...defaultAlertSettings, ...(settings ?? {}) };
  const minimum = new Decimal(item.minStock);
  const severity =
    config.enabled && item.isActive
      ? classify(quantity, minimum, config.criticalPercent)
      : null;
  const now = new Date();
  if (!severity) {
    if (active)
      await tx.stockAlert.update({
        where: { id: active.id },
        data: { status: 'RESOLVED', resolvedAt: now, quantity },
      });
    return;
  }
  if (!active) {
    await tx.stockAlert.create({
      data: {
        tenantId: ref.tenantId,
        warehouseId: ref.warehouseId,
        stockItemId: ref.stockItemId,
        severity,
        quantity,
        threshold: minimum,
      },
    });
    return;
  }
  const worse = rank[severity] > rank[active.severity as Severity];
  await tx.stockAlert.update({
    where: { id: active.id },
    data: {
      severity,
      quantity,
      threshold: minimum,
      // A worse level asks for attention again; a better one never silences or re-opens.
      ...(worse
        ? { status: 'OPEN', acknowledgedAt: null, acknowledgedById: null }
        : {}),
    },
  });
}
