import { describe, expect, it } from 'vitest';
import { EscPos } from '../src/printing/escpos.js';
import {
  receiptTemplateSchema,
  templateSettingsOf,
} from '../src/printing/receipt-template.js';
import { receiptTicket, sampleReceipt } from '../src/printing/receipt.js';

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

    const ticketBytes = receiptTicket(sample, settings);
    const text = Buffer.from(ticketBytes).toString('latin1');

    // Double separator uses '='
    expect(text).toContain('='.repeat(30));
    // Contains Delivery section
    expect(text).toContain('YETKAZIB BERISH (DOSTAVKA)');
    // Contains Waiter
    expect(text).toContain('Ofitsiant: Sardor');
    // Contains Fiscal block
    expect(text).toContain('OFD FISKAL CHEK');
    expect(text).toContain('STIR: 301234567');
    // Contains Social media
    expect(text).toContain('Ijtimoiy tarmoq: @azizxon');
    // Contains QR label
    expect(text).toContain('Fikr bildirish uchun skanerlang');
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

