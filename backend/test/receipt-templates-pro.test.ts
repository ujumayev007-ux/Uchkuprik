import { describe, expect, it } from 'vitest';
import { EscPos } from '../src/printing/escpos.js';
import {
  receiptTemplateSchema,
  templateSettingsOf,
} from '../src/printing/receipt-template.js';
import {
  localDateTime,
  receiptTicket,
  sampleReceipt,
} from '../src/printing/receipt.js';

describe('Receipt Template Schema & Pro Designer', () => {
  it('validates receipt templates with default and custom settings', () => {
    const parsed = receiptTemplateSchema.parse({
      separatorStyle: 'double',
      showQrCode: true,
      qrContent: 'https://azizxon.uz/pay',
      qrLabel: 'To‘lash uchun skanerlang',
      showBarcode: true,
      showFiscalData: true,
      showDeliveryDetails: true,
      showSocialMedia: true,
      socialMedia: '@choyxona_azizxon',
    });

    expect(parsed.separatorStyle).toBe('double');
    expect(parsed.showQrCode).toBe(true);
    expect(parsed.qrContent).toBe('https://azizxon.uz/pay');
    expect(parsed.showBarcode).toBe(true);
    expect(parsed.showFiscalData).toBe(true);
    expect(parsed.showDeliveryDetails).toBe(true);
    expect(parsed.socialMedia).toBe('@choyxona_azizxon');
  });

  it('normalizes legacy or missing template settings with safe defaults', () => {
    const settings = templateSettingsOf({});
    expect(settings.separatorStyle).toBe('dashed');
    expect(settings.showQrCode).toBe(false);
    expect(settings.showBarcode).toBe(false);
    expect(settings.showFiscalData).toBe(false);
  });
});

describe('ESC/POS QR Code and Barcode generation', () => {
  it('generates standard ESC/POS QR code command sequence', () => {
    const doc = new EscPos().qrCode('https://azizxon.uz', 4);
    const bytes = Buffer.from(doc.build());
    // GS ( k is 0x1d, 0x28, 0x6b
    expect(bytes[2]).toBe(0x1d);
    expect(bytes[3]).toBe(0x28);
    expect(bytes[4]).toBe(0x6b);
    expect(bytes.toString('utf-8')).toContain('https://azizxon.uz');
  });

  it('generates standard ESC/POS barcode command sequence', () => {
    const doc = new EscPos().barcode('00012345', 50);
    const bytes = Buffer.from(doc.build());
    // GS h (0x1d 0x68) and GS k (0x1d 0x6b)
    expect(bytes.includes(0x1d)).toBe(true);
    expect(bytes.toString('ascii')).toContain('00012345');
  });
});

describe('Receipt Ticket Formatting', () => {
  it('formats receipt with double separator, QR code, and fiscal data', () => {
    const sample = sampleReceipt('CHOYXONA AZIZXON');
    const settings = receiptTemplateSchema.parse({
      separatorStyle: 'double',
      showQrCode: true,
      qrContent: 'https://azizxon.uz/feedback',
      qrLabel: 'Fikr bildirish uchun skanerlang',
      showBarcode: true,
      showFiscalData: true,
      showDeliveryDetails: true,
      showWaiter: true,
      showSocialMedia: true,
      socialMedia: '@azizxon',
    });

    const plain = Buffer.from(receiptTicket(sample, settings)).toString('latin1');
    // Without an address, a fiscal sign or a copy nothing is invented.
    expect(plain).not.toContain('YETKAZIB BERISH');
    expect(plain).not.toContain('FISKAL CHEK');
    expect(plain).not.toContain('NUSXA');

    const ticketBytes = receiptTicket(
      {
        ...sample,
        customer: { name: 'Ali', phone: '+998 90 111 22 33', address: 'Yunusobod 5' },
        fiscal: { fiscalSign: 'FS123', qrUrl: 'https://ofd.soliq.uz/check?t=1' },
        copy: 1,
      },
      settings,
    );
    const text = Buffer.from(ticketBytes).toString('latin1');

    // Double separator uses '='
    expect(text).toContain('='.repeat(30));
    expect(text).toContain('YETKAZIB BERISH');
    expect(text).toContain('Manzil: Yunusobod 5');
    expect(text).toContain('Mijoz: Ali, +998 90 111 22 33');
    expect(text).toContain('Ofitsiant: Ofitsiant');
    expect(text).toContain('FISKAL CHEK');
    expect(text).toContain('Fiskal belgi: FS123');
    expect(text).toContain('STIR: 301234567');
    expect(text).toContain('NUSXA');
    // Contains Social media
    expect(text).toContain('Ijtimoiy tarmoq: @azizxon');
    // Contains QR label
    expect(text).toContain('Fikr bildirish uchun skanerlang');
  });

  it('prints the large number, item count, VAT and the Wi-Fi block when enabled', () => {
    const settings = receiptTemplateSchema.parse({
      largeOrderNumber: true,
      showItemCount: true,
      showVat: true,
      vatPercent: 12,
      showWifi: true,
      wifiName: 'Restoran',
      wifiPassword: 'parol123',
      wifiQr: true,
    });
    const text = Buffer.from(receiptTicket(sampleReceipt(), settings)).toString('latin1');
    expect(text).toContain('Taomlar soni');
    // 110 000 × 12 / 112 = 11 786
    expect(text).toContain('Shu jumladan QQS 12%');
    expect(text).toContain('11 786');
    expect(text).toContain('Wi-Fi: Restoran');
    expect(text).toContain('Parol: parol123');
    expect(text).toContain('WIFI:T:WPA;S:Restoran;P:parol123;;');
  });

  it('shows the time in the branch time zone, not UTC', () => {
    expect(localDateTime(new Date('2026-10-25T20:30:00Z'))).toBe('2026-10-26 01:30');
  });

  it('formats receipt with stars separator for branded template', () => {
    const sample = sampleReceipt('CHOYXONA AZIZXON');
    const settings = receiptTemplateSchema.parse({
      separatorStyle: 'stars',
      showSocialMedia: true,
      socialMedia: '@azizxon',
    });

    const ticketBytes = receiptTicket(sample, settings);
    const text = Buffer.from(ticketBytes).toString('latin1');
    expect(text).toContain('*'.repeat(30));
  });
});

