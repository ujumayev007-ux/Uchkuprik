/**
 * Bozorlik prices: a line is entered as quantity + unit and either the price of one
 * pricing unit or the total paid; the other one is worked out. Grams and millilitres
 * are priced per kilogram / litre (how the market sells them), every other unit per
 * itself. Amounts are whole so‘m.
 */

/** "1,5" / "1.5" / " 2 " → number; null when not a positive number. */
export function parseQuantity(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Keeps only what a decimal quantity may contain (digits and one point). */
export function cleanQuantityInput(text: string): string {
  const value = text.replace(',', '.').replace(/[^\d.]/g, '');
  const point = value.indexOf('.');
  return point === -1
    ? value.slice(0, 9)
    : `${value.slice(0, point).slice(0, 9)}.${value
        .slice(point + 1)
        .replace(/\./g, '')
        .slice(0, 3)}`;
}

/** The unit a price is given for, and how many of it one entered unit is. */
export function pricingUnit(unitName: string): { unit: string; per: number } {
  if (unitName === 'g') return { unit: 'kg', per: 1 / 1000 };
  if (unitName === 'ml') return { unit: 'l', per: 1 / 1000 };
  return { unit: unitName, per: 1 };
}

/** Quantity expressed in the pricing unit (750 g → 0.75 kg). */
const pricedQuantity = (quantity: number, unitName: string) =>
  quantity * pricingUnit(unitName).per;

/** Total = quantity × unit price (whole so‘m); null without a quantity or price. */
export function totalFromPrice(
  quantityText: string,
  unitName: string,
  unitPrice: number | null,
): number | null {
  const quantity = parseQuantity(quantityText);
  if (quantity === null || unitPrice === null || unitPrice < 0) return null;
  const total = Math.round(pricedQuantity(quantity, unitName) * unitPrice);
  return Number.isSafeInteger(total) ? total : null;
}

/** Unit price = total ÷ quantity (whole so‘m); null when the quantity is 0 or missing. */
export function priceFromTotal(
  quantityText: string,
  unitName: string,
  total: number | null,
): number | null {
  const quantity = parseQuantity(quantityText);
  if (quantity === null || total === null || total < 0) return null;
  const amount = pricedQuantity(quantity, unitName);
  if (!(amount > 0)) return null;
  const price = Math.round(total / amount);
  return Number.isSafeInteger(price) ? price : null;
}
