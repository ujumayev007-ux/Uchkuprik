import type { CSSProperties } from 'react';

// Receipt / ticket template settings (mirrors backend/src/printing/receipt-template.ts).

export type ReceiptLayout = {
  widthMm: number;
  fontSize: 'small' | 'normal' | 'large';
  lineSpacing: 'tight' | 'normal' | 'loose';
  marginLeftMm: number;
  marginRightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  lengthMode: 'auto' | 'fixed';
  fixedLengthMm: number;
  showLogo: boolean;
  logo: string;
  logoWidthPct: number;
  showBusinessName: boolean;
  showLegalName: boolean;
  showTaxId: boolean;
  showBranch: boolean;
  showPhone: boolean;
  showCashier: boolean;
  showWaiter: boolean;
  showOrderNumber: boolean;
  showDateTime: boolean;
  showOrderType: boolean;
  showTable: boolean;
  showModifiers: boolean;
  showItemUnitPrice: boolean;
  showNotes: boolean;
  showDiscount: boolean;
  showServiceCharge: boolean;
  showPayments: boolean;
  showChange: boolean;
  largeItems: boolean;
  title: string;
  extraLines: string;
  thankYou: string;
};

export const defaultLayout: ReceiptLayout = {
  widthMm: 80,
  fontSize: 'normal',
  lineSpacing: 'normal',
  marginLeftMm: 2,
  marginRightMm: 2,
  marginTopMm: 2,
  marginBottomMm: 8,
  lengthMode: 'auto',
  fixedLengthMm: 200,
  showLogo: false,
  logo: '',
  logoWidthPct: 60,
  showBusinessName: true,
  showLegalName: true,
  showTaxId: true,
  showBranch: true,
  showPhone: true,
  showCashier: true,
  showWaiter: true,
  showOrderNumber: true,
  showDateTime: true,
  showOrderType: true,
  showTable: true,
  showModifiers: true,
  showItemUnitPrice: true,
  showNotes: true,
  showDiscount: true,
  showServiceCharge: true,
  showPayments: true,
  showChange: true,
  largeItems: true,
  title: '',
  extraLines: '',
  thankYou: 'Xaridingiz uchun rahmat!',
};

/** Old servers sent `paperWidth: '58' | '80'`; read both shapes. */
export function normalizeLayout(value: unknown): ReceiptLayout {
  const raw = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Record<string, unknown>;
  const widthMm =
    typeof raw.widthMm === 'number'
      ? raw.widthMm
      : raw.paperWidth === '58'
        ? 58
        : 80;
  return { ...defaultLayout, ...raw, widthMm } as ReceiptLayout;
}

/** Characters per line on a thermal printer (58 mm → 32, 80 mm → 48). */
export function columnsForWidth(widthMm: number, marginsMm = 0) {
  const dots = Math.max(160, (widthMm - (widthMm <= 60 ? 10 : 8)) * 8);
  return Math.max(16, Math.floor((dots - marginsMm * 8) / 12));
}

const FONT_PX = { small: 11, normal: 13, large: 16 } as const;
const LINE_HEIGHT = { tight: 1.15, normal: 1.35, loose: 1.75 } as const;

/** CSS of the paper: width, margins, font, spacing and (fixed) length in millimetres. */
export function sheetStyle(layout: ReceiptLayout): CSSProperties {
  return {
    width: `${layout.widthMm}mm`,
    boxSizing: 'border-box',
    padding: `${layout.marginTopMm}mm ${layout.marginRightMm}mm ${layout.marginBottomMm}mm ${layout.marginLeftMm}mm`,
    fontSize: `${FONT_PX[layout.fontSize]}px`,
    lineHeight: LINE_HEIGHT[layout.lineSpacing],
    ...(layout.lengthMode === 'fixed'
      ? { minHeight: `${layout.fixedLengthMm}mm` }
      : {}),
  };
}

/** Print rules: the page is exactly the paper width; the length follows the content. */
export function pageCss(layout: ReceiptLayout): string {
  const length =
    layout.lengthMode === 'fixed' ? `${layout.fixedLengthMm}mm` : 'auto';
  return `@page { size: ${layout.widthMm}mm ${length}; margin: 0; }`;
}

/** Resizes a picked logo to a small PNG so it fits the template (and the database). */
export async function logoFromFile(file: File): Promise<string> {
  // data: URLs only: the page's content-security policy does not allow blob: images.
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('IMAGE'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('IMAGE'));
    image.src = source;
  });
  const scale = Math.min(1, 384 / image.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL('image/png');
  return png.length <= 240_000 ? png : canvas.toDataURL('image/jpeg', 0.7);
}
