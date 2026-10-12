import type { Db, Tx } from '../../db.js';

export type PricedVariant = {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  categoryId: string;
  price: number;
  cost: number | null;
  available: boolean;
};

/**
 * Server-authoritative prices for one branch: the branch override when present,
 * otherwise the variant's base price. Orders must use this, never client prices.
 */
export async function priceVariants(
  db: Db | Tx,
  tenantId: string,
  branchId: string,
  variantIds: string[],
): Promise<Map<string, PricedVariant>> {
  const variants = await db.productVariant.findMany({
    where: { tenantId, id: { in: variantIds } },
    include: {
      product: { include: { category: true } },
      branchPrices: { where: { branchId } },
    },
  });
  const result = new Map<string, PricedVariant>();
  for (const variant of variants) {
    const override = variant.branchPrices[0];
    result.set(variant.id, {
      variantId: variant.id,
      productId: variant.productId,
      productName: variant.product.name,
      variantName: variant.name,
      categoryId: variant.product.categoryId,
      price: override?.price ?? variant.price,
      cost: variant.cost,
      available:
        variant.isActive &&
        variant.product.isActive &&
        variant.product.deletedAt === null &&
        variant.product.category.isActive &&
        (override?.isAvailable ?? true),
    });
  }
  return result;
}
