import { Prisma } from '../../generated/prisma/client.js';
import type { Services } from '../../context.js';
import type { AuthContext } from '../auth/session.js';
import { baseUnitLabels, defaultWarehouse } from '../inventory/ledger.js';
import { reportRange, type SalesQuery } from './sales.js';

const { Decimal } = Prisma;

export const movementLabels: Record<string, string> = {
  RECEIPT: 'Kirim',
  SUPPLIER_RETURN: 'Yetkazib beruvchiga qaytarish',
  SALE: 'Sotuv',
  WASTE: 'Isrof',
  ADJUSTMENT: 'Tuzatish',
  TRANSFER_IN: 'Ko‘chirish (kirim)',
  TRANSFER_OUT: 'Ko‘chirish (chiqim)',
  STOCKTAKE: 'Inventarizatsiya',
};

/** Cost values follow the same rule as the inventory screen. */
export const canSeeStockCost = (auth: AuthContext) =>
  (auth.permissions.has('inventory.manage') ||
    auth.permissions.has('finance.view')) &&
  auth.financial.cost;

/**
 * Stock balances (now) and the stock movements of the period, from the same ledger the
 * Ombor screen uses. Movement quantities are in base units (g, ml, dona).
 */
export async function loadInventory(
  services: Services,
  auth: AuthContext,
  query: SalesQuery,
) {
  const { db } = services;
  const { branch, from, to } = await reportRange(services, auth, query);
  const warehouse = await db.$transaction((tx) =>
    defaultWarehouse(tx, auth.tenantId, branch.id),
  );
  const costs = canSeeStockCost(auth);
  const items = await db.stockItem.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: { name: 'asc' },
    include: { balances: { where: { warehouseId: warehouse.id } } },
  });
  const balances = items
    .filter((item) => item.isActive || item.balances[0])
    .map((item) => {
      const quantity = new Decimal(item.balances[0]?.quantity ?? 0);
      const status = quantity.lessThanOrEqualTo(0)
        ? 'OUT'
        : quantity.lessThan(item.minStock)
          ? 'LOW'
          : 'OK';
      return {
        id: item.id,
        name: item.name,
        unit: baseUnitLabels[item.baseUnit],
        quantity: quantity.toString(),
        minStock: item.minStock.toString(),
        status,
        ...(costs
          ? {
              // Average purchase price per base unit (g, ml, dona).
              avgCost: new Decimal(item.balances[0]?.avgCost ?? 0)
                .toDecimalPlaces(3)
                .toString(),
              value: quantity.isPositive()
                ? Math.round(
                    quantity.times(item.balances[0]?.avgCost ?? 0).toNumber(),
                  )
                : 0,
            }
          : {}),
      };
    });

  // The restaurant's calendar days (not UTC days) bound the movements.
  const rows = await db.$queryRaw<
    {
      at: Date;
      itemId: string;
      name: string;
      unit: string;
      type: string;
      quantity: Prisma.Decimal;
      balanceAfter: Prisma.Decimal;
      reason: string | null;
    }[]
  >`
    SELECT m."createdAt" AS at, s.id AS "itemId", s.name AS name, s."baseUnit"::text AS unit, m.type::text AS type,
           m.quantity AS quantity, m."balanceAfter" AS "balanceAfter", m.reason AS reason
    FROM stock_movements m JOIN stock_items s ON s.id = m."stockItemId"
    WHERE m."tenantId" = ${auth.tenantId}::uuid AND m."warehouseId" = ${warehouse.id}::uuid
      AND ((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${branch.timezone})::date BETWEEN ${from}::date AND ${to}::date
    ORDER BY m."createdAt" ASC LIMIT 2000`;
  const movements = rows.map((row) => ({
    at: row.at,
    itemId: row.itemId,
    name: row.name,
    unit: baseUnitLabels[row.unit as keyof typeof baseUnitLabels] ?? row.unit,
    type: movementLabels[row.type] ?? row.type,
    quantity: new Decimal(row.quantity).toString(),
    balanceAfter: new Decimal(row.balanceAfter).toString(),
    reason: row.reason ?? '',
  }));
  return { branch, warehouse: warehouse.name, balances, movements };
}

const purchaseStatus: Record<string, string> = {
  DRAFT: 'Qoralama',
  RECEIVED: 'Qabul qilingan',
  CANCELLED: 'Bekor qilingan',
};

/**
 * Purchases of the branch's warehouse in the period (by the receiving day, or the
 * creation day of a purchase not received yet), in the restaurant's calendar days.
 */
export async function loadPurchases(
  services: Services,
  auth: AuthContext,
  query: SalesQuery,
) {
  const { db } = services;
  const { branch, from, to } = await reportRange(services, auth, query);
  const warehouse = await db.$transaction((tx) =>
    defaultWarehouse(tx, auth.tenantId, branch.id),
  );
  const rows = await db.$queryRaw<
    {
      at: Date;
      supplier: string;
      invoiceNo: string | null;
      status: string;
      lines: bigint;
      total: number;
    }[]
  >`
    SELECT COALESCE(p."receivedAt", p."createdAt") AS at, s.name AS supplier, p."invoiceNo" AS "invoiceNo",
           p.status::text AS status, (SELECT count(*) FROM purchase_lines l WHERE l."purchaseId" = p.id) AS lines,
           p.total AS total
    FROM purchases p JOIN suppliers s ON s.id = p."supplierId"
    WHERE p."tenantId" = ${auth.tenantId}::uuid AND p."warehouseId" = ${warehouse.id}::uuid
      AND ((COALESCE(p."receivedAt", p."createdAt") AT TIME ZONE 'UTC') AT TIME ZONE ${branch.timezone})::date BETWEEN ${from}::date AND ${to}::date
    ORDER BY at ASC LIMIT 2000`;
  return rows.map((row) => ({
    at: row.at,
    supplier: row.supplier,
    invoiceNo: row.invoiceNo ?? '',
    status: purchaseStatus[row.status] ?? row.status,
    cancelled: row.status === 'CANCELLED',
    lines: Number(row.lines),
    total: row.total,
  }));
}
