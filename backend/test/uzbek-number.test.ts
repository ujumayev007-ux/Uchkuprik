import { describe, expect, it } from 'vitest';
import {
  formatOrderNo,
  readyAnnouncement,
  uzbekCardinal,
  uzbekOrdinal,
  walkinAnnouncement,
} from '../../frontend/src/lib/uzbek-number.js';

describe('Uzbek number words', () => {
  it('speaks cardinals beyond single digits', () => {
    expect(uzbekCardinal(7)).toBe('yetti');
    expect(uzbekCardinal(10)).toBe('o‘n');
    expect(uzbekCardinal(11)).toBe('o‘n bir');
    expect(uzbekCardinal(45)).toBe('qirq besh');
    expect(uzbekCardinal(100)).toBe('yuz');
    expect(uzbekCardinal(123)).toBe('yuz yigirma uch');
    expect(uzbekCardinal(250)).toBe('ikki yuz ellik');
    expect(uzbekCardinal(999)).toBe('to‘qqiz yuz to‘qson to‘qqiz');
    expect(uzbekCardinal(1000)).toBe('ming');
    expect(uzbekCardinal(2024)).toBe('ikki ming yigirma to‘rt');
  });

  it('builds ordinals with -inchi / -nchi', () => {
    expect(uzbekOrdinal(1)).toBe('birinchi');
    expect(uzbekOrdinal(2)).toBe('ikkinchi');
    expect(uzbekOrdinal(3)).toBe('uchinchi');
    expect(uzbekOrdinal(4)).toBe('to‘rtinchi');
    expect(uzbekOrdinal(7)).toBe('yettinchi');
    expect(uzbekOrdinal(10)).toBe('o‘ninchi');
    expect(uzbekOrdinal(20)).toBe('yigirmanchi');
    expect(uzbekOrdinal(21)).toBe('yigirma birinchi');
    expect(uzbekOrdinal(30)).toBe('o‘ttizinchi');
    expect(uzbekOrdinal(100)).toBe('yuzinchi');
    expect(uzbekOrdinal(105)).toBe('yuz beshinchi');
  });

  it('announces ready orders in natural Uzbek', () => {
    expect(readyAnnouncement(7)).toBe('Yettinchi buyurtma tayyor.');
    expect(readyAnnouncement(12)).toBe('O‘n ikkinchi buyurtma tayyor.');
    expect(readyAnnouncement(7, 'cardinal')).toBe(
      'Yetti raqamli buyurtma tayyor.',
    );
    expect(walkinAnnouncement).toBe(
      'Yangi mijoz buyurtmasi. Stolni belgilang.',
    );
  });

  it('formats order numbers with leading zeros', () => {
    expect(formatOrderNo(1)).toBe('№001');
    expect(formatOrderNo(12)).toBe('№012');
    expect(formatOrderNo(123)).toBe('№123');
    expect(formatOrderNo(1234)).toBe('№1234');
  });
});
