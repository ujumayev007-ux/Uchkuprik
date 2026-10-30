import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blockOrder, receiptTicket, sampleReceipt } from '../src/printing/receipt.js';
import { templateSettingsOf } from '../src/printing/receipt-template.js';

// Receipt parts in a chosen order; templates without one print exactly as before.
const now = new Date('2026-10-29T10:00:00Z');
const data = {
  ...sampleReceipt('FAST FOOD', now),
  customer: { name: 'Ali', phone: '+998901112233', address: 'Chilonzor 5' },
  fiscal: { fiscalSign: 'FS123', qrUrl: 'https://ofd.example/q' },
  copy: 1,
};
const variants = [
  {},
  { fontSize: 'large', largeOrderNumber: true, showItemCount: true, showVat: true },
  {
    showDeliveryDetails: true,
    showFiscalData: true,
    showSocialMedia: true,
    socialMedia: '@x',
    showWifi: true,
    wifiName: 'Cafe',
    wifiPassword: '123',
    wifiQr: true,
    showQrCode: true,
    qrContent: 'https://x',
    qrLabel: 'Skan',
    showBarcode: true,
    extraLines: 'A\nB',
    title: 'CHEK',
    lengthMode: 'fixed',
  },
  { fontSize: 'small', separatorStyle: 'stars', widthMm: 58, showCopyMark: false },
];
// Bytes printed by the renderer before receipt parts could be reordered (1.15.8).
const BEFORE = ['2dca48ed18a620a7', '1e06175c7404d61e', 'ed89987db79e1dbf', 'd080301198e07d21'];

describe('receipt blocks', () => {
  it('prints byte-identical receipts without a chosen order', () => {
    const hashes = variants.map((variant) =>
      createHash('sha256')
        .update(receiptTicket(data, templateSettingsOf(variant)))
        .digest('hex')
        .slice(0, 16),
    );
    expect(hashes).toEqual(BEFORE);
  });
  it('a chosen order moves the parts', () => {
    expect(blockOrder(['footer', 'x', 'footer', 'logo'])[0]).toBe('footer');
    expect(blockOrder(['footer']).length).toBe(11);
    const settings = templateSettingsOf({ ...variants[2], layoutOrder: ['footer', 'items'] });
    const text = Buffer.from(receiptTicket(data, settings)).toString('latin1');
    expect(text.indexOf('Xaridingiz')).toBeLessThan(text.indexOf('Oila seti'));
    expect(text.indexOf('Oila seti')).toBeLessThan(text.indexOf('FAST FOOD'));
  });
});
