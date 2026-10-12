import type { Tx } from '../../db.js';
import {
  Prisma,
  type StockMovementType,
} from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;
export const ZERO = new Decimal(0);

export const baseUnitLabels = { G: 'g', ML: 'ml', PCS: 'dona' } as const;

/** Each branch has one default warehouse, created on first use. */
export async function defaultWarehouse(
  tx: Tx,
  tenantId: string,
  branchId: string,
) {
  const existing = await tx.warehouse.findFirst({
    where: { tenantId, branchId, isDefault: true },
  });
  if (existing) return existing;
  await tx.$executeRaw`
    INSERT INTO warehouses (id, "tenantId", "branchId", name, "isDefault", "isActive", "createdAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${branchId}::uuid, 'Asosiy ombor', true, true, now())
    ON CONFLICT DO NOTHING`;
  return tx.warehouse.findFirstOrThrow({
    where: { tenantId, branchId, isDefault: true },
  });
}

export type MovementInput = {
  tenantId: string;
  warehouseId: string;
  stockItemId: string;
  type: StockMovementType;
  // Signed change in base units: positive adds stock, negative removes it.
  quantity: Decimal;
  // Required for incoming stock with a known purchase cost; otherwise the average is used.
  unitCost?: Decimal;
  referenceType?: string;
  referenceId?: string;
  reason?: string | null;
  actorId: string | null;
  allowNegative: boolean;
};

/**
 * Posts one ledger movement and updates the balance under a row lock, so concurrent
 * sales, receipts and counts cannot lose updates. Incoming stock with a cost updates
 * the weighted average cost; outgoing stock is valued at the current average.
 */
export async function postMovement(tx: Tx, input: MovementInput) {
  if (input.quantity.isZero()) return null;
  await tx.$executeRaw`
    INSERT INTO stock_balances ("tenantId", "warehouseId", "stockItemId", quantity, "avgCost", "updatedAt")
    VALUES (${input.tenantId}::uuid, ${input.warehouseId}::uuid, ${input.stockItemId}::uuid, 0, 0, now())
    ON CONFLICT DO NOTHING`;
  const rows = await tx.$queryRaw<{ quantity: Decimal; avgCost: Decimal }[]>`
    SELECT quantity, "avgCost" FROM stock_balances
    WHERE "warehouseId" = ${input.warehouseId}::uuid AND "stockItemId" = ${input.stockItemId}::uuid
    FOR UPDATE`;
  const current = new Decimal(rows[0]!.quantity);
  const avg = new Decimal(rows[0]!.avgCost);
  const next = current.plus(input.quantity);
  if (input.quantity.isNegative() && next.isNegative() && !input.allowNegative)
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'insufficientStock', {
      stockItemId: input.stockItemId,
      available: current.toString(),
    });
  let nextAvg = avg;
  let unitCost = avg;
  if (input.quantity.isPositive() && input.unitCost) {
    unitCost = input.unitCost;
    nextAvg = current.isPositive()
      ? current
          .times(avg)
          .plus(input.quantity.times(input.unitCost))
          .dividedBy(next)
      : input.unitCost;
  }
  await tx.stockBalance.update({
    where: {
      warehouseId_stockItemId: {
        warehouseId: input.warehouseId,
        stockItemId: input.stockItemId,
      },
    },
    data: { quantity: next, avgCost: nextAvg.toDecimalPlaces(4) },
  });
  return tx.stockMovement.create({
    data: {
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      stockItemId: input.stockItemId,
      type: input.type,
      quantity: input.quantity,
      unitCost: unitCost.toDecimalPlaces(4),
      balanceAfter: next,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      reason: input.reason ?? null,
      createdById: input.actorId,
    },
  });
}

/**
 * Deducts recipe ingredients for a completed order from the branch's default
 * warehouse. Runs inside the completion transaction; the order state machine
 * guarantees each order completes (and is deducted) exactly once.
 */
export async function consumeOrderIngredients(
  tx: Tx,
  orderId: string,
  actorId: string | null,
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { where: { status: 'ACTIVE' } } },
  });
  const recipes = await tx.recipeLine.findMany({
    where: {
      tenantId: order.tenantId,
      variantId: {
        in: [...new Set(order.items.map((item) => item.variantId))],
      },
    },
  });
  if (recipes.length === 0) return;
  const usage = new Map<string, Decimal>();
  for (const item of order.items)
    for (const line of recipes.filter(
      (recipe) => recipe.variantId === item.variantId,
    ))
      usage.set(
        line.stockItemId,
        (usage.get(line.stockItemId) ?? ZERO).plus(
          new Decimal(line.quantity).times(item.quantity),
        ),
      );
  const profile = await tx.tenantProfile.findUnique({
    where: { tenantId: order.tenantId },
  });
  const warehouse = await defaultWarehouse(tx, order.tenantId, order.branchId);
  // Stable lock order (by id) avoids deadlocks between concurrent completions.
  for (const [stockItemId, quantity] of [...usage].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    await postMovement(tx, {
      tenantId: order.tenantId,
      warehouseId: warehouse.id,
      stockItemId,
      type: 'SALE',
      quantity: quantity.negated(),
      referenceType: 'order',
      referenceId: order.id,
      actorId,
      allowNegative: profile?.allowNegativeStock ?? true,
    });
}
