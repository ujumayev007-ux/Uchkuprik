import { describe, expect, it } from 'vitest';
import { isAllowedPrinterHost } from '../src/modules/printing/printers.routes.js';
import {
  COLUMNS,
  EscPos,
  kitchenTicket,
  toPrintable,
} from '../src/printing/escpos.js';

describe('ESC/POS encoding', () => {
  it('maps Uzbek punctuation to printable ASCII', () => {
    expect(toPrintable('Qo‘shimcha ma’lumot № 5 — tayyor')).toBe(
      "Qo'shimcha ma'lumot N 5 - tayyor",
    );
    expect(toPrintable('Oʻzbekiston')).toBe("O'zbekiston");
  });

  it('pads two-column lines to the paper width and ends with a cut', () => {
    const bytes = Buffer.from(
      new EscPos().pair('Jami', '130 000').cut().build(),
    );
    const text = bytes.toString('latin1');
    const line = text.slice(2, text.indexOf('\n'));
    expect(line).toHaveLength(COLUMNS);
    expect(line.endsWith('130 000')).toBe(true);
    expect([...bytes.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });

  it('fits kitchen tickets to 58 mm paper', () => {
    const text = Buffer.from(
      kitchenTicket({
        stationName: null,
        number: 7,
        typeLabel: 'Olib ketish',
        table: null,
        note: null,
        priority: 0,
        createdAt: new Date('2026-10-12T09:30:00Z'),
        timezone: 'Asia/Tashkent',
        items: [{ quantity: 1, name: 'Somsa', modifiers: [], note: null }],
        columns: 32,
      }),
    ).toString('latin1');
    expect(text).toContain('-'.repeat(32) + String.fromCharCode(10));
    expect(text).not.toContain('-'.repeat(33));
  });

  it('renders kitchen tickets without prices', () => {
    const text = Buffer.from(
      kitchenTicket({
        stationName: 'Grill',
        number: 42,
        typeLabel: 'Olib ketish',
        table: null,
        note: 'Tezroq',
        priority: 1,
        createdAt: new Date('2026-10-12T09:30:00Z'),
        timezone: 'Asia/Tashkent',
        items: [
          {
            quantity: 2,
            name: 'Burger',
            modifiers: ['Pishloq'],
            note: 'Piyozsiz',
          },
        ],
      }),
    ).toString('latin1');
    for (const part of [
      'GRILL',
      'SHOSHILINCH',
      'N 42',
      '14:30',
      '2 x Burger',
      '+ Pishloq',
      '! Piyozsiz',
      'Izoh: Tezroq',
    ])
      expect(text).toContain(part);
    expect(text).not.toMatch(/so'm|\d{2} \d{3}/);
  });
});

describe('printer host allow-list', () => {
  it('accepts only private LAN IPv4 addresses', () => {
    for (const host of [
      '192.168.1.20',
      '10.0.0.5',
      '172.16.0.9',
      '172.31.255.1',
    ])
      expect(isAllowedPrinterHost(host)).toBe(true);
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '172.32.0.1',
      '8.8.8.8',
      '0.0.0.0',
      'localhost',
      '192.168.1.300',
      '::1',
    ])
      expect(isAllowedPrinterHost(host)).toBe(false);
  });
});
