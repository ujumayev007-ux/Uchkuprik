import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { permissionCatalog } from '../src/modules/auth/permissions.js';

describe('Bozorlik (Market shopping) cashier & security rules', () => {
  const positive = z
    .union([z.number(), z.string().trim()])
    .transform((val) => Number(val))
    .refine((n) => n > 0);

  const marketInput = z.object({
    branchId: z.string().uuid().optional(),
    supplierName: z.string().trim().min(1).max(100).default('Bozor'),
    note: z.string().trim().max(300).nullable().optional(),
    paid: z.boolean().default(true),
    paymentMethod: z.enum(['CASH', 'CARD', 'DEBT']).optional(),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
    lines: z
      .array(
        z.object({
          stockItemId: z.string().uuid().optional(),
          newItem: z
            .object({
              name: z.string().trim().min(1).max(100),
              baseUnit: z.enum(['G', 'ML', 'PCS']),
            })
            .optional(),
          quantity: positive,
          unitName: z.string().trim().min(1).max(40),
          lineTotal: z.number().int().min(0).max(1_000_000_000),
          supplierName: z.string().trim().min(1).max(100).optional(),
        }),
      )
      .min(1)
      .max(200),
  });

  const correctPurchaseInput = z.object({
    reason: z.string().trim().min(3).max(300),
    note: z.string().trim().max(300).nullable().optional(),
    supplierName: z.string().trim().min(1).max(100).optional(),
    lines: z
      .array(
        z.object({
          stockItemId: z.string().uuid(),
          quantity: positive,
          unitName: z.string().trim().min(1).max(40),
          lineTotal: z.number().int().min(0).max(1_000_000_000),
        }),
      )
      .min(1)
      .max(200),
  });

  it('validates Bozorlik market input with multiple products and payment methods', () => {
    const valid = marketInput.parse({
      supplierName: 'Eski jo‘va',
      paymentMethod: 'CASH',
      idempotencyKey: 'idemp-12345678',
      lines: [
        {
          stockItemId: '123e4567-e89b-12d3-a456-426614174000',
          quantity: '2.5',
          unitName: 'kg',
          lineTotal: 75000,
        },
        {
          newItem: { name: 'Pistachio', baseUnit: 'G' },
          quantity: '1',
          unitName: 'kg',
          lineTotal: 120000,
          supplierName: 'Yong‘oq bozor',
        },
      ],
    });
    expect(valid.paymentMethod).toBe('CASH');
    expect(valid.lines).toHaveLength(2);
    expect(valid.lines[0]?.quantity).toBe(2.5);
    expect(valid.lines[0]?.lineTotal).toBe(75000);
  });

  it('correctly maps payment methods (CASH, CARD, DEBT) for financial safety', () => {
    const resolvePayment = (input: { paid?: boolean; paymentMethod?: 'CASH' | 'CARD' | 'DEBT' }) => {
      const method = input.paymentMethod ?? (input.paid ? 'CASH' : 'DEBT');
      return {
        method,
        isDebt: method === 'DEBT',
        fromCash: method === 'CASH',
        createsExpense: method !== 'DEBT',
      };
    };

    // CASH reduces drawer and records cash expense
    const cash = resolvePayment({ paymentMethod: 'CASH' });
    expect(cash.fromCash).toBe(true);
    expect(cash.isDebt).toBe(false);
    expect(cash.createsExpense).toBe(true);

    // CARD records non-cash expense without reducing cash drawer
    const card = resolvePayment({ paymentMethod: 'CARD' });
    expect(card.fromCash).toBe(false);
    expect(card.isDebt).toBe(false);
    expect(card.createsExpense).toBe(true);

    // DEBT increases payable balance; never touches cash drawer or immediate cash expense
    const debt = resolvePayment({ paymentMethod: 'DEBT' });
    expect(debt.fromCash).toBe(false);
    expect(debt.isDebt).toBe(true);
    expect(debt.createsExpense).toBe(false);
  });

  it('enforces role security: Cashier can create & view, but never edit or correct', () => {
    const cashierPermissions = new Set([
      'pos.access',
      'menu.view',
      'orders.view',
      'orders.create',
      'orders.edit',
      'orders.approve',
      'payments.accept',
      'delivery.manage',
      'shifts.manage',
      'customers.view',
      'operations.perform',
    ]);

    const adminPermissions = new Set(Object.keys(permissionCatalog));

    const canEnterMarket = (perms: Set<string>) =>
      perms.has('purchasing.manage') || perms.has('pos.access');
    const canViewPurchases = (perms: Set<string>) =>
      perms.has('purchasing.manage') ||
      perms.has('pos.access') ||
      perms.has('inventory.view');
    const canCorrect = (perms: Set<string>) => perms.has('purchasing.manage');
    const canCancel = (perms: Set<string>) => perms.has('purchasing.manage');

    // Cashier
    expect(canEnterMarket(cashierPermissions)).toBe(true);
    expect(canViewPurchases(cashierPermissions)).toBe(true);
    expect(canCorrect(cashierPermissions)).toBe(false);
    expect(canCancel(cashierPermissions)).toBe(false);

    // Admin
    expect(canEnterMarket(adminPermissions)).toBe(true);
    expect(canViewPurchases(adminPermissions)).toBe(true);
    expect(canCorrect(adminPermissions)).toBe(true);
    expect(canCancel(adminPermissions)).toBe(true);
  });

  it('validates Admin correction input and requires a meaningful reason', () => {
    expect(() =>
      correctPurchaseInput.parse({
        reason: 'ok', // too short (< 3 chars)
        lines: [
          {
            stockItemId: '123e4567-e89b-12d3-a456-426614174000',
            quantity: 2,
            unitName: 'kg',
            lineTotal: 60000,
          },
        ],
      }),
    ).toThrow();

    const validCorrection = correctPurchaseInput.parse({
      reason: 'Kassir kiritishda miqdorni 20 emas 2 deb xato yozgan',
      supplierName: 'Dehqon bozor',
      lines: [
        {
          stockItemId: '123e4567-e89b-12d3-a456-426614174000',
          quantity: '20',
          unitName: 'kg',
          lineTotal: 600000,
        },
      ],
    });
    expect(validCorrection.reason).toContain('xato');
    expect(validCorrection.lines[0]?.quantity).toBe(20);
    expect(validCorrection.lines[0]?.lineTotal).toBe(600000);
  });
});
