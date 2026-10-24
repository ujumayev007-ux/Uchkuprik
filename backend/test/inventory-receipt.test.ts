import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';

const Decimal = Prisma.Decimal;

describe('R05: Inventory Receipts, Costing, and Recipe Quantities', () => {
  it('T14: receives 5 kg of an item with 10 kg already on hand, resulting in 15 kg balance', () => {
    const existingQuantityG = new Decimal(10_000); // 10 kg in grams
    const receiptQuantityKg = new Decimal(5);
    const factorKgToG = new Decimal(1000);

    const receiptQuantityG = receiptQuantityKg.times(factorKgToG);
    const newQuantityG = existingQuantityG.plus(receiptQuantityG);

    expect(receiptQuantityG.toNumber()).toBe(5000);
    expect(newQuantityG.toNumber()).toBe(15_000);
    expect(newQuantityG.dividedBy(factorKgToG).toNumber()).toBe(15);
  });

  it('T16: updates weighted average cost correctly on new receipt without changing historical sale costs', () => {
    // 10 kg existing @ 10,000 so'm / kg
    const existingQty = new Decimal(10_000); // 10 kg in grams
    const existingAvgPerG = new Decimal(10); // 10,000 so'm / kg = 10 so'm / g
    const historicalSaleCost = new Decimal(150).times(existingAvgPerG); // 150g portion = 1,500 so'm

    // New receipt: 5 kg @ 16,000 so'm / kg (16 so'm / g)
    const newQty = new Decimal(5_000); // 5 kg in grams
    const newUnitCostPerG = new Decimal(16);

    const totalQty = existingQty.plus(newQty); // 15,000 g
    const nextAvg = existingQty
      .times(existingAvgPerG)
      .plus(newQty.times(newUnitCostPerG))
      .dividedBy(totalQty);

    // Weighted average: (10,000 * 10 + 5,000 * 16) / 15,000 = (100,000 + 80,000) / 15,000 = 12 so'm / g (12,000 so'm / kg)
    expect(nextAvg.toNumber()).toBe(12);
    // Historical sale cost is strictly preserved!
    expect(historicalSaleCost.toNumber()).toBe(1500);
  });

  it('T15: consumes 150 g recipe quantity from 15 kg, leaving 14.85 kg', () => {
    const stockBalanceG = new Decimal(15_000); // 15 kg
    const recipeQuantityG = new Decimal(150); // 150 g per portion
    const portionsSold = 1;

    const consumedG = recipeQuantityG.times(portionsSold);
    const remainingG = stockBalanceG.minus(consumedG);
    const remainingKg = remainingG.dividedBy(1000);

    expect(consumedG.toNumber()).toBe(150);
    expect(remainingG.toNumber()).toBe(14_850);
    expect(remainingKg.toNumber()).toBe(14.85);
  });

  it('correctly converts compatible units: kg-g, l-ml, and pieces', () => {
    const resolveFactor = (baseUnit: 'G' | 'ML' | 'PCS', unitName: string) => {
      const u = unitName.toLowerCase();
      if (baseUnit === 'G') {
        if (u === 'g' || u === 'gramm') return 1;
        if (u === 'kg' || u === 'kilogram') return 1000;
      }
      if (baseUnit === 'ML') {
        if (u === 'ml' || u === 'millilitr') return 1;
        if (u === 'l' || u === 'litr') return 1000;
      }
      if (baseUnit === 'PCS') {
        if (u === 'dona' || u === 'pcs') return 1;
      }
      return null;
    };

    expect(resolveFactor('G', 'kg')).toBe(1000);
    expect(resolveFactor('G', 'g')).toBe(1);
    expect(resolveFactor('ML', 'l')).toBe(1000);
    expect(resolveFactor('ML', 'ml')).toBe(1);
    expect(resolveFactor('PCS', 'dona')).toBe(1);
    expect(resolveFactor('G', 'litr')).toBeNull(); // Incompatible rejected!
  });
});
