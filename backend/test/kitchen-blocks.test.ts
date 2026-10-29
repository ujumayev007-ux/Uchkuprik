import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kitchenTicket, type KitchenTicket } from '../src/printing/escpos.js';
import { kitchenLayoutOf } from '../src/printing/kitchen-design.js';
import { templateSettingsOf } from '../src/printing/receipt-template.js';

// Kitchen ticket design (parts order, fields, sizes); tickets without these settings
// print exactly as before.
const base: KitchenTicket = {
  stationName: 'Kabob',
  number: 17,
  typeLabel: 'Zalda',
  table: '5-stol',
  note: 'Tezroq',
  priority: 1,
  createdAt: new Date('2026-10-29T10:00:00Z'),
  timezone: 'Asia/Tashkent',
  items: [
    { quantity: 2, name: 'Shashlik', modifiers: ['Piyoz'], note: 'Achchiq' },
    { quantity: 1, name: 'Lavash', modifiers: [], note: null, price: 30_000 },
  ],
  columns: 48,
};
const variants: KitchenTicket[] = [
  base,
  { ...base, delivery: true, waiter: 'Ali', columns: 32 },
  {
    ...base,
    update: true,
    version: 3,
    changedBy: 'Vali',
    changedAt: new Date('2026-10-29T10:05:00Z'),
    cancelled: [{ quantity: 1, name: 'Choy', modifiers: [], note: null }],
    waiter: 'Ali',
  },
  {
    ...base,
    priority: 0,
    template: {
      header: 'OSHXONA 1',
      footer: 'Rahmat',
      largeItems: false,
      showWaiter: false,
      showNotes: false,
    },
    waiter: 'Ali',
  },
];
// Bytes printed before kitchen tickets could be designed (workflows branch, 2026-10-30).
const BEFORE = [
  '990897b7f566a87a',
  '45aad21070fada01',
  '01430474b5f37927',
  '6163809fa83b4497',
];
const hash = (ticket: KitchenTicket) =>
  createHash('sha256').update(kitchenTicket(ticket)).digest('hex').slice(0, 16);

describe('kitchen ticket design', () => {
  it('prints byte-identical tickets without design settings', () => {
    expect(variants.map(hash)).toEqual(BEFORE);
  });
});

describe('kitchen ticket designer settings', () => {
  const station = {
    header: 'OSHXONA 1',
    footer: 'Rahmat',
    largeItems: true,
    showWaiter: true,
    showNotes: true,
    copies: 1,
  };
  const print = (settings: object) =>
    Buffer.from(
      kitchenTicket({
        ...base,
        waiter: 'Ali',
        template: kitchenLayoutOf(templateSettingsOf(settings), station),
      }),
    ).toString('latin1');

  it('a named template left at its defaults prints as named templates did before', () => {
    const defaults = templateSettingsOf({});
    // The mapping before the designer settings: texts, large items, waiter, notes.
    const before = {
      ...station,
      header: defaults.title || station.header,
      footer: defaults.thankYou || station.footer,
      largeItems: defaults.largeItems,
      showWaiter: defaults.showWaiter,
      showNotes: defaults.showNotes,
    };
    expect(
      hash({
        ...base,
        waiter: 'Ali',
        template: kitchenLayoutOf(defaults, station),
      }),
    ).toBe(hash({ ...base, waiter: 'Ali', template: before }));
  });

  it('applies visible fields, sizes, separator, extra lines and the order of parts', () => {
    const text = print({
      showTable: false,
      showModifiers: false,
      showStation: false,
      separatorStyle: 'stars',
      extraLines: 'Allergiya: yong‘oq',
      layoutOrder: ['items', 'number'],
    });
    expect(text).not.toContain('5-stol');
    expect(text).not.toContain('+ Piyoz');
    expect(text).not.toContain('KABOB');
    expect(text).toContain('*'.repeat(48));
    expect(text).toContain('Allergiya');
    expect(text.indexOf('2 x Shashlik')).toBeLessThan(text.indexOf('N 17'));
    // Item size 2x2: ESC/POS GS ! 0x11.
    expect(print({ kitchenItemSize: 'big' })).toContain('\x1d!\x11');
    // The order number in normal letters: no 2x2 before it.
    const small = print({
      kitchenLargeNumber: false,
      kitchenItemSize: 'normal',
    });
    expect(small).not.toContain('\x1d!\x11');
  });
});
