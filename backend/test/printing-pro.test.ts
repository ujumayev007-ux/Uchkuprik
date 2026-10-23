import { describe, expect, it } from 'vitest';
import { EscPos } from '../src/printing/escpos.js';
import { isAllowedPrinterHost } from '../src/modules/printing/printers.routes.js';

describe('Professional Printer Management', () => {
  it('validates allowed private LAN printer hosts and blocks public/loopback IPs', () => {
    // Valid private LAN
    expect(isAllowedPrinterHost('192.168.1.100')).toBe(true);
    expect(isAllowedPrinterHost('192.168.0.250')).toBe(true);
    expect(isAllowedPrinterHost('10.0.0.15')).toBe(true);
    expect(isAllowedPrinterHost('172.16.0.5')).toBe(true);
    expect(isAllowedPrinterHost('172.31.255.254')).toBe(true);

    // Blocked public / loopback / cloud metadata
    expect(isAllowedPrinterHost('127.0.0.1')).toBe(false);
    expect(isAllowedPrinterHost('169.254.169.254')).toBe(false);
    expect(isAllowedPrinterHost('8.8.8.8')).toBe(false);
    expect(isAllowedPrinterHost('localhost')).toBe(false);
    expect(isAllowedPrinterHost('192.168.1.999')).toBe(false);
  });

  it('generates auto-cut and cash drawer kick-out pulses in ESC/POS', () => {
    const esc = new EscPos(48);
    esc.line('TEST RECEIPT');
    esc.cashDrawer(2); // pin 2 cash drawer
    esc.cut(); // paper cut
    const bytes = esc.build();

    // Check cash drawer pulse: 0x1b, 0x70, 0x00, 0x19, 0xfa
    const str = Buffer.from(bytes).toString('hex');
    expect(str).toContain('1b700019fa');

    // Check cut command: 0x1d, 0x56, 0x42, 0x00
    expect(str).toContain('1d564200');
  });

  it('supports 58 mm (32 columns) and 80 mm (48 columns) paper formats', () => {
    const esc58 = new EscPos(32);
    esc58.pair('Non', '5 000');
    const bytes58 = esc58.build();
    const line58 = Buffer.from(bytes58).toString('ascii');
    expect(line58).toContain('Non');
    expect(line58).toContain('5 000');

    const esc80 = new EscPos(48);
    esc80.pair('Lag‘mon katta', '45 000');
    const bytes80 = esc80.build();
    const line80 = Buffer.from(bytes80).toString('ascii');
    expect(line80).toContain("Lag'mon katta");
    expect(line80).toContain('45 000');
  });

  it('routes ordered items to department printers (Fish, Kebab, Fast Food, Drinks, Kitchen)', () => {
    const printers = [
      { id: 'p-kassa', name: 'Kassa chek printer', kind: 'RECEIPT', stationId: 's-kassa' },
      { id: 'p-oshxona', name: 'Oshxona umumiy', kind: 'KITCHEN', stationId: null }, // receives all
      { id: 'p-baliq', name: 'Baliqxona printer', kind: 'KITCHEN', stationId: 's-baliq' },
      { id: 'p-kabob', name: 'Kabobxona printer', kind: 'KITCHEN', stationId: 's-kabob' },
      { id: 'p-ichimlik', name: 'Bar / Ichimliklar', kind: 'KITCHEN', stationId: 's-ichimlik' },
    ];

    const items = [
      { id: 'i1', name: 'Sazan qovurma', stationId: 's-baliq' },
      { id: 'i2', name: 'Qiyma kabob', stationId: 's-kabob' },
      { id: 'i3', name: 'Coca Cola 1.5L', stationId: 's-ichimlik' },
      { id: 'i4', name: 'Non', stationId: null },
    ];

    const routeFor = (printer: typeof printers[0]) =>
      items.filter(
        (item) => !printer.stationId || !item.stationId || item.stationId === printer.stationId,
      );

    // Baliqxona only receives fish items
    const baliqItems = routeFor(printers.find((p) => p.stationId === 's-baliq')!);
    expect(baliqItems.map((i) => i.name)).toEqual(['Sazan qovurma', 'Non']);

    // Kabobxona only receives kebab items
    const kabobItems = routeFor(printers.find((p) => p.stationId === 's-kabob')!);
    expect(kabobItems.map((i) => i.name)).toEqual(['Qiyma kabob', 'Non']);

    // General kitchen printer receives all items
    const generalItems = routeFor(printers.find((p) => p.stationId === null)!);
    expect(generalItems).toHaveLength(4);
  });

  it('detects IP address and port collision between printers', () => {
    const existingPrinters = [
      { id: 'p1', name: 'Kassa printer', host: '192.168.1.200', port: 9100, isActive: true },
      { id: 'p2', name: 'Oshxona printer', host: '192.168.1.201', port: 9100, isActive: true },
      { id: 'p3', name: 'Eski printer', host: '192.168.1.202', port: 9100, isActive: false },
    ];

    const checkCollision = (input: { id?: string; host: string; port: number }) => {
      return existingPrinters.find(
        (p) => p.id !== input.id && p.host === input.host && p.port === input.port && p.isActive,
      );
    };

    expect(checkCollision({ host: '192.168.1.200', port: 9100 })?.name).toBe('Kassa printer');
    expect(checkCollision({ host: '192.168.1.201', port: 9100 })?.name).toBe('Oshxona printer');
    // Inactive printer does not collide
    expect(checkCollision({ host: '192.168.1.202', port: 9100 })).toBeUndefined();
    // Unique IP does not collide
    expect(checkCollision({ host: '192.168.1.205', port: 9100 })).toBeUndefined();
    // Same printer editing itself does not collide
    expect(checkCollision({ id: 'p1', host: '192.168.1.200', port: 9100 })).toBeUndefined();
  });
});
