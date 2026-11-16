import { describe, expect, it } from 'vitest';
import {
  cleanQuantityInput,
  parseQuantity,
  priceFromTotal,
  pricingUnit,
  totalFromPrice,
} from '../../frontend/src/lib/market-price.js';
import {
  matchProducts,
  normalizeName,
} from '../../frontend/src/lib/product-match.js';

describe('Bozorlik price ↔ total', () => {
  it('total = quantity × unit price for dona and kg', () => {
    expect(totalFromPrice('3', 'dona', 2500)).toBe(7500);
    expect(totalFromPrice('1.5', 'kg', 8000)).toBe(12000);
    expect(totalFromPrice('0,25', 'kg', 90000)).toBe(22500);
  });

  it('grams are priced per kilogram', () => {
    expect(pricingUnit('g')).toEqual({ unit: 'kg', per: 0.001 });
    expect(totalFromPrice('750', 'g', 8000)).toBe(6000);
    expect(priceFromTotal('750', 'g', 6000)).toBe(8000);
    expect(totalFromPrice('500', 'ml', 12000)).toBe(6000);
  });

  it('unit price = total ÷ quantity, never ÷ 0', () => {
    expect(priceFromTotal('2', 'kg', 180000)).toBe(90000);
    expect(priceFromTotal('3', 'dona', 10000)).toBe(3333);
    expect(priceFromTotal('0', 'kg', 10000)).toBeNull();
    expect(priceFromTotal('', 'kg', 10000)).toBeNull();
    expect(priceFromTotal('abc', 'kg', 10000)).toBeNull();
    expect(totalFromPrice('0', 'kg', 10000)).toBeNull();
    expect(totalFromPrice('2', 'kg', null)).toBeNull();
  });

  it('cleans what is typed into the quantity', () => {
    expect(cleanQuantityInput('1,5')).toBe('1.5');
    expect(cleanQuantityInput('1.2.3')).toBe('1.23');
    expect(cleanQuantityInput('0.12345')).toBe('0.123');
    expect(cleanQuantityInput('12a')).toBe('12');
    expect(parseQuantity('1.')).toBeNull();
    expect(parseQuantity('0.5')).toBe(0.5);
  });
});

describe('Bozorlik product search', () => {
  const items = [
    { id: '1', name: 'Go‘sht (mol)' },
    { id: '2', name: 'Kartoshka' },
    { id: '3', name: 'Qo‘y go‘shti' },
    { id: '4', name: 'Sabzi' },
  ];

  it('ignores case and apostrophes; words in any order', () => {
    expect(normalizeName('  GO’SHT  ')).toBe('gosht');
    expect(matchProducts(items, 'gosht').map((i) => i.id)).toEqual(['1', '3']);
    expect(matchProducts(items, 'go‘shti qo‘y').map((i) => i.id)).toEqual([
      '3',
    ]);
    expect(matchProducts(items, 'kar').map((i) => i.id)).toEqual(['2']);
    expect(matchProducts(items, 'xyz')).toEqual([]);
  });
});
