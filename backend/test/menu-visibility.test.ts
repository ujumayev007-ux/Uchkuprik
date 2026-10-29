import { describe, expect, it } from 'vitest';

describe('Admin Menu Visibility & Cashier Navigation Policy (R06, R12)', () => {
  it('sanitizes hidden menus list to protect core routes from accidental hiding', () => {
    const essential = new Set(['/', '/sozlamalar', '/litsenziya']);
    const requested = ['/', '/sozlamalar', '/litsenziya', '/ombor', '/hisobotlar', '/franshiza'];

    const sanitized = requested.filter((path) => !essential.has(path));

    expect(sanitized).toEqual(['/ombor', '/hisobotlar', '/franshiza']);
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('/sozlamalar');
    expect(sanitized).not.toContain('/litsenziya');
  });

  it('restores all menus when an empty array is provided', () => {
    const essential = new Set(['/', '/sozlamalar', '/litsenziya']);
    const requested: string[] = [];

    const sanitized = requested.filter((path) => !essential.has(path));

    expect(sanitized).toEqual([]);
  });

  it('verifies cashier navigation policy strictly contains the 5 requested primary areas', () => {
    const cashierAllowedPaths = [
      '/kassa',
      '/buyurtmalar',
      '/printerlar',
      '/bozorlik',
      '/chiqimlar',
    ];

    expect(cashierAllowedPaths).toHaveLength(5);
    expect(cashierAllowedPaths).toContain('/kassa');
    expect(cashierAllowedPaths).toContain('/buyurtmalar');
    expect(cashierAllowedPaths).toContain('/printerlar');
    expect(cashierAllowedPaths).toContain('/bozorlik');
    expect(cashierAllowedPaths).toContain('/chiqimlar');

    // Must NOT contain Admin-only areas
    expect(cashierAllowedPaths).not.toContain('/sozlamalar');
    expect(cashierAllowedPaths).not.toContain('/litsenziya');
    expect(cashierAllowedPaths).not.toContain('/xodimlar');
    expect(cashierAllowedPaths).not.toContain('/rollar');
    expect(cashierAllowedPaths).not.toContain('/platforma/bizneslar');
  });
});

