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
  logoAlign: 'left' | 'center' | 'right';
  logoRaster: { w: number; h: number; data: string } | null;
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
  separatorStyle: 'single' | 'dashed' | 'double' | 'stars' | 'heavy';
  showQrCode: boolean;
  qrContent: string;
  qrLabel: string;
  showBarcode: boolean;
  showFiscalData: boolean;
  showDeliveryDetails: boolean;
  showSocialMedia: boolean;
  socialMedia: string;
  largeOrderNumber: boolean;
  showCustomer: boolean;
  showItemCount: boolean;
  showVat: boolean;
  vatPercent: number;
  showWifi: boolean;
  wifiName: string;
  wifiPassword: string;
  wifiQr: boolean;
  showCopyMark: boolean;
  // Kitchen tickets: item size, the order number in double size, the department.
  kitchenItemSize?: 'normal' | 'tall' | 'big';
  kitchenLargeNumber?: boolean;
  showStation?: boolean;
  presetKey?: string;
  sectionOrder?: string[];
  /** Order of the receipt parts; absent: the usual order. */
  layoutOrder?: string[];
  /** Browser printing on an office printer; thermal printers keep the roll width. */
  pageSize?: 'roll' | 'A4' | 'A5';
};

/** Receipt parts in the printed order (backend/src/printing/receipt.ts). */
export const RECEIPT_BLOCKS = [
  'logo',
  'header',
  'meta',
  'delivery',
  'items',
  'totals',
  'fiscal',
  'wifi',
  'qr',
  'barcode',
  'footer',
] as const;
export type ReceiptBlock = (typeof RECEIPT_BLOCKS)[number];

/** The chosen order: unknown names dropped, parts left out appended. */
export function blockOrder(chosen: readonly string[]): ReceiptBlock[] {
  const known = chosen.filter((name): name is ReceiptBlock =>
    (RECEIPT_BLOCKS as readonly string[]).includes(name),
  );
  const unique = [...new Set(known)];
  return [
    ...unique,
    ...RECEIPT_BLOCKS.filter((name) => !unique.includes(name)),
  ];
}

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
  logoAlign: 'center',
  logoRaster: null,
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
  separatorStyle: 'dashed',
  showQrCode: false,
  qrContent: '',
  qrLabel: '',
  showBarcode: false,
  showFiscalData: false,
  showDeliveryDetails: false,
  showSocialMedia: false,
  socialMedia: '',
  largeOrderNumber: false,
  showCustomer: true,
  showItemCount: false,
  showVat: false,
  vatPercent: 12,
  showWifi: false,
  wifiName: '',
  wifiPassword: '',
  wifiQr: false,
  showCopyMark: true,
  sectionOrder: [
    'logo',
    'header',
    'meta',
    'items',
    'totals',
    'delivery',
    'fiscal',
    'qr',
    'barcode',
    'footer',
  ],
};

/** 6 professional editable template presets required by the system. */
type ReceiptPreset = {
  name: string;
  kind: 'CUSTOMER' | 'KITCHEN';
  desc: string;
  layout: Partial<ReceiptLayout>;
};

const basePresets: Record<
  'classic' | 'premium' | 'minimal' | 'kitchen' | 'delivery' | 'branded',
  ReceiptPreset
> = {
  classic: {
    name: 'Klassik (Classic)',
    kind: 'CUSTOMER',
    desc: 'Standart va qulay chek dizayni — barcha turdagi tez ovqatlanish shoxobchalariga mos.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'normal',
      showLogo: false,
      showBusinessName: true,
      showLegalName: true,
      showTaxId: true,
      showBranch: true,
      showPhone: true,
      showCashier: true,
      showWaiter: false,
      showOrderNumber: true,
      showDateTime: true,
      showOrderType: true,
      showTable: true,
      showModifiers: true,
      showItemUnitPrice: true,
      showDiscount: true,
      showPayments: true,
      showChange: true,
      separatorStyle: 'dashed',
      thankYou: 'Xaridingiz uchun rahmat!',
    },
  },
  premium: {
    name: 'Premium',
    kind: 'CUSTOMER',
    desc: 'Zamonaviy ikki chiziqli dizayn, batafsil xizmat va chegirmalar, fikr-mulohaza uchun QR-kod.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'normal',
      showLogo: true,
      logoAlign: 'center',
      logoWidthPct: 65,
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
      showDiscount: true,
      showServiceCharge: true,
      showPayments: true,
      showChange: true,
      showQrCode: true,
      qrContent: '',
      qrLabel: 'Fikr va takliflar uchun skanerlang',
      separatorStyle: 'double',
      thankYou: 'Tashrifingizdan mamnunmiz! Yana kuting!',
    },
  },
  minimal: {
    name: 'Minimal',
    kind: 'CUSTOMER',
    desc: 'Tejamkor va tez chop etiladigan ixcham chek — 58 mm qog‘oz va tezkor xizmat uchun.',
    layout: {
      widthMm: 58,
      fontSize: 'small',
      lineSpacing: 'tight',
      marginTopMm: 0,
      marginBottomMm: 4,
      showLogo: false,
      showBusinessName: true,
      showLegalName: false,
      showTaxId: false,
      showBranch: false,
      showPhone: false,
      showCashier: false,
      showWaiter: false,
      showOrderNumber: true,
      showDateTime: true,
      showOrderType: false,
      showTable: false,
      showModifiers: false,
      showItemUnitPrice: false,
      showDiscount: true,
      showPayments: true,
      showChange: false,
      separatorStyle: 'single',
      thankYou: 'Rahmat!',
    },
  },
  kitchen: {
    name: 'Oshxona (Kitchen Ticket)',
    kind: 'KITCHEN',
    desc: 'Oshpazlar uchun katta harflar, stol raqami, buyurtma vaqti va taom izohlari.',
    layout: {
      widthMm: 80,
      fontSize: 'large',
      lineSpacing: 'normal',
      showLogo: false,
      showBusinessName: false,
      showLegalName: false,
      showTaxId: false,
      showBranch: false,
      showPhone: false,
      showCashier: false,
      showWaiter: true,
      showOrderNumber: true,
      showDateTime: true,
      showOrderType: true,
      showTable: true,
      showModifiers: true,
      showItemUnitPrice: false,
      showNotes: true,
      showDiscount: false,
      showServiceCharge: false,
      showPayments: false,
      showChange: false,
      largeItems: true,
      title: 'OSHXONA BUYURTMASI',
      separatorStyle: 'heavy',
      thankYou: '',
    },
  },
  delivery: {
    name: 'Yetkazib berish (Delivery Note)',
    kind: 'CUSTOMER',
    desc: 'Kuryer va mijoz uchun: mijoz ismi, manzili, telefoni, to‘lov turi va shtrixkod.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'normal',
      showLogo: false,
      showBusinessName: true,
      showPhone: true,
      showOrderNumber: true,
      showDateTime: true,
      showOrderType: true,
      showDeliveryDetails: true,
      showItemUnitPrice: true,
      showModifiers: true,
      showNotes: true,
      showDiscount: true,
      showPayments: true,
      showBarcode: true,
      title: 'YETKAZIB BERISH (DOSTAVKA)',
      separatorStyle: 'dashed',
      thankYou: 'Yoqimli ishtaha! Bizni tanlaganingiz uchun rahmat!',
    },
  },
  branded: {
    name: 'Brendli (Branded)',
    kind: 'CUSTOMER',
    desc: 'Restoran logotipi, ijtimoiy tarmoqlar, Telegram-bot QR-kodi va firma uslubi.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'normal',
      showLogo: true,
      logoAlign: 'center',
      logoWidthPct: 75,
      showBusinessName: true,
      showPhone: true,
      showSocialMedia: true,
      socialMedia: '@azizxon_choyxona',
      showOrderNumber: true,
      showDateTime: true,
      showQrCode: true,
      qrContent: '',
      qrLabel: 'Telegram botimiz orqali buyurtma bering',
      showBarcode: true,
      showFiscalData: true,
      separatorStyle: 'stars',
      thankYou: 'Bizni tanlaganingiz uchun rahmat!',
    },
  },
};

/** Library designs added next to the six above (none of them changes a saved template). */
const libraryPresets = {
  modern: {
    name: 'Zamonaviy (Modern)',
    kind: 'CUSTOMER',
    desc: 'Toza ko‘rinish, yakka chiziqlar, QQS va taomlar soni bilan.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'loose',
      showLegalName: false,
      showTaxId: true,
      showWaiter: false,
      showItemCount: true,
      showVat: true,
      separatorStyle: 'single',
      title: '',
      thankYou: 'Rahmat! Yana kutib qolamiz.',
    },
  },
  bold: {
    name: 'Qalin (Bold)',
    kind: 'CUSTOMER',
    desc: 'Katta shrift, qalin ajratgichlar — uzoqdan ham o‘qiladi.',
    layout: {
      widthMm: 80,
      fontSize: 'large',
      lineSpacing: 'normal',
      largeOrderNumber: true,
      showItemUnitPrice: false,
      separatorStyle: 'heavy',
      thankYou: 'RAHMAT!',
    },
  },
  compact: {
    name: 'Ixcham (Compact)',
    kind: 'CUSTOMER',
    desc: '58 mm, kichik shrift, faqat eng kerakli qatorlar — qog‘ozni tejaydi.',
    layout: {
      widthMm: 58,
      fontSize: 'small',
      lineSpacing: 'tight',
      marginTopMm: 0,
      marginBottomMm: 3,
      showLegalName: false,
      showTaxId: false,
      showBranch: false,
      showCashier: false,
      showWaiter: false,
      showOrderType: false,
      showModifiers: false,
      showItemUnitPrice: false,
      showCustomer: false,
      separatorStyle: 'single',
      thankYou: 'Rahmat!',
    },
  },
  fastfood: {
    name: 'Fast Food',
    kind: 'CUSTOMER',
    desc: 'Navbat raqami katta harflarda — mijozni kassadan chaqirish uchun.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      largeOrderNumber: true,
      showOrderNumber: true,
      showOrderType: true,
      showTable: false,
      showWaiter: false,
      showItemCount: true,
      separatorStyle: 'dashed',
      title: 'NAVBAT RAQAMINGIZ',
      thankYou: 'Raqamingiz ekranda chiqqanda olib keting!',
    },
  },
  vip: {
    name: 'VIP',
    kind: 'CUSTOMER',
    desc: 'Logotip, ofitsiant, xizmat haqi va qo‘shaloq chiziqlar — VIP zal uchun.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      lineSpacing: 'loose',
      showLogo: true,
      logoAlign: 'center',
      logoWidthPct: 55,
      showWaiter: true,
      showTable: true,
      showServiceCharge: true,
      showItemUnitPrice: true,
      separatorStyle: 'double',
      title: 'VIP',
      thankYou: 'Tashrifingiz uchun minnatdormiz!',
    },
  },
  qr: {
    name: 'QR chek',
    kind: 'CUSTOMER',
    desc: 'Pastida katta QR-kod: fikr bildirish, menyu yoki Telegram bot uchun.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      showQrCode: true,
      qrContent: '',
      qrLabel: 'Skanerlang: menyu va takliflar',
      showWifi: false,
      separatorStyle: 'dashed',
      thankYou: 'Xaridingiz uchun rahmat!',
    },
  },
  custom: {
    name: 'Bo‘sh (Custom)',
    kind: 'CUSTOMER',
    desc: 'Eng oddiy boshlanish: faqat nom, raqam, taomlar va jami — qolganini o‘zingiz qo‘shasiz.',
    layout: {
      widthMm: 80,
      fontSize: 'normal',
      showLogo: false,
      showLegalName: false,
      showTaxId: false,
      showBranch: false,
      showPhone: false,
      showCashier: false,
      showWaiter: false,
      showOrderType: false,
      showTable: false,
      showModifiers: false,
      showItemUnitPrice: false,
      showNotes: false,
      showDiscount: true,
      showServiceCharge: false,
      showPayments: false,
      showChange: false,
      showCustomer: false,
      showQrCode: false,
      showBarcode: false,
      showWifi: false,
      showSocialMedia: false,
      title: '',
      extraLines: '',
      separatorStyle: 'single',
      thankYou: 'Rahmat!',
    },
  },
} satisfies Record<string, ReceiptPreset>;

export const receiptPresets: Record<
  keyof typeof basePresets | keyof typeof libraryPresets,
  ReceiptPreset
> = { ...basePresets, ...libraryPresets };

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
/** Printable width of an office page with 10 mm margins. */
const PAGE_WIDTH_MM = { A4: 190, A5: 128 } as const;

export function sheetStyle(layout: ReceiptLayout): CSSProperties {
  const page =
    layout.pageSize === 'A4' || layout.pageSize === 'A5'
      ? PAGE_WIDTH_MM[layout.pageSize]
      : null;
  return {
    width: `${page ?? layout.widthMm}mm`,
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
  if (layout.pageSize === 'A4' || layout.pageSize === 'A5')
    return `@page { size: ${layout.pageSize}; margin: 10mm; }`;
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

/** Printable width in dots of a thermal printer (mirrors the server). */
const printableDots = (widthMm: number) =>
  Math.max(160, (widthMm - (widthMm <= 60 ? 10 : 8)) * 8);

/**
 * The logo as a 1-bit picture sized for the paper: width follows the chosen percentage
 * of the printable width (rounded to whole bytes), black dots where the picture is dark.
 * Returns null when there is no logo to print.
 */
export async function rasterizeLogo(
  layout: ReceiptLayout,
): Promise<ReceiptLayout['logoRaster']> {
  if (!layout.showLogo || !layout.logo) return null;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('IMAGE'));
    image.src = layout.logo;
  });
  const printable =
    printableDots(layout.widthMm) -
    (layout.marginLeftMm + layout.marginRightMm) * 8;
  const width = Math.max(
    8,
    Math.min(
      Math.floor(printable / 8) * 8,
      Math.round((printable * layout.logoWidthPct) / 100 / 8) * 8,
    ),
  );
  const height = Math.max(
    1,
    Math.min(400, Math.round((image.height * width) / image.width)),
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const bytes = new Uint8Array((width >> 3) * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const luminance =
        0.299 * (pixels[at] ?? 255) +
        0.587 * (pixels[at + 1] ?? 255) +
        0.114 * (pixels[at + 2] ?? 255);
      if (luminance < 150)
        bytes[y * (width >> 3) + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { w: width, h: height, data: btoa(binary) };
}
