import type { Db, Tx } from '../../db.js';

const isFastFood = (name: string) =>
  name.toLocaleLowerCase('uz').replace(/[^a-z]/g, '') === 'fastfood';

/**
 * Menu variants the kitchen prepares. A restaurant with a «Fast Food» menu category
 * sends only that category (and its sub-categories) to the kitchen screens and kitchen
 * tickets; drinks, water and other categories stay with the cashier. Without such a
 * category every item goes to the kitchen, as before (null). Orders and totals are
 * never changed by this.
 */
export async function kitchenVariantIds(
  db: Db | Tx,
  tenantId: string,
): Promise<string[] | null> {
  const categories = await db.menuCategory.findMany({
    where: { tenantId },
    select: { id: true, parentId: true, name: true },
  });
  const chosen = new Set(
    categories.filter((c) => isFastFood(c.name)).map((c) => c.id),
  );
  if (chosen.size === 0) return null;
  for (let grew = true; grew;) {
    grew = false;
    for (const c of categories)
      if (c.parentId && chosen.has(c.parentId) && !chosen.has(c.id)) {
        chosen.add(c.id);
        grew = true;
      }
  }
  const variants = await db.productVariant.findMany({
    where: { product: { tenantId, categoryId: { in: [...chosen] } } },
    select: { id: true },
  });
  return variants.map((v) => v.id);
}
