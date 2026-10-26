import { strFromU8, unzipSync } from 'fflate';
import writeXlsxFile from 'write-excel-file/node';
import { safeText } from '../reports/export/xlsx.js';

/**
 * Menu import from Excel: the downloadable template, a small reader for the .xlsx it
 * comes back as (Excel, LibreOffice or Google Sheets), and row checks. Nothing is
 * written here; the menu routes save the rows that passed, in one transaction.
 */

export const MAX_IMPORT_ROWS = 500;

type ColumnKey =
  | 'name'
  | 'category'
  | 'price'
  | 'cost'
  | 'variant'
  | 'description'
  | 'sku'
  | 'barcode'
  | 'prep'
  | 'visible';

const COLUMNS: { key: ColumnKey; label: string; width: number; match: string }[] = [
  { key: 'name', label: 'Taom nomi *', width: 30, match: 'taom nomi' },
  { key: 'category', label: 'Kategoriya *', width: 22, match: 'kategoriya' },
  { key: 'price', label: 'Sotuv narxi (so‘m) *', width: 20, match: 'sotuv narxi' },
  { key: 'cost', label: 'Tannarx (so‘m)', width: 16, match: 'tannarx' },
  { key: 'variant', label: 'O‘lcham / birlik', width: 18, match: "o'lcham" },
  { key: 'description', label: 'Tavsif', width: 34, match: 'tavsif' },
  { key: 'sku', label: 'Artikul (SKU)', width: 16, match: 'artikul' },
  { key: 'barcode', label: 'Shtrix-kod', width: 18, match: 'shtrix' },
  { key: 'prep', label: 'Tayyorlash vaqti (daqiqa)', width: 24, match: 'tayyorlash' },
  { key: 'visible', label: 'Ko‘rinadi (Ha / Yo‘q)', width: 20, match: "ko'rinadi" },
];

// Uzbek apostrophes are typed in many ways (‘ ’ ʻ ʼ ` ').
export const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The template: an empty "Taomlar" sheet to fill and a "Qo‘llanma" sheet with help. */
export async function importTemplate(categories: string[]): Promise<Buffer> {
  const header = COLUMNS.map((column) => ({
    value: column.label,
    type: String,
    fontWeight: 'bold',
    backgroundColor: '#E8E4DA',
  }));
  const text = (value: string, bold = false) => ({
    value: safeText(value),
    type: String,
    ...(bold ? { fontWeight: 'bold' } : {}),
  });
  const guide = [
    [{ value: 'Taomlarni Exceldan yuklash — qo‘llanma', type: String, fontWeight: 'bold', fontSize: 14 }],
    [],
    [text('1. “Taomlar” varag‘ida har bir qatorga bitta taom yozing (sarlavha qatorini o‘zgartirmang).')],
    [text('2. * belgili ustunlar majburiy: Taom nomi, Kategoriya, Sotuv narxi.')],
    [text('3. Narxlar butun son bilan, so‘mda: 28000 (bo‘shliq yoki “so‘m” yozmasa ham bo‘ladi).')],
    [text('4. Kategoriya menyuda bo‘lmasa, yangi kategoriya yaratiladi.')],
    [text('5. “Ko‘rinadi” ustuni: Ha — menyuda ko‘rinadi, Yo‘q — yashirilgan. Bo‘sh bo‘lsa “Ha”.')],
    [text('6. “O‘lcham / birlik” bo‘sh bo‘lsa “Standart” deb olinadi (masalan: 0.5 L, Katta, 1 dona).')],
    [text('7. Menyuda allaqachon bor taomlar o‘zgartirilmaydi — ular xato sifatida ko‘rsatiladi.')],
    [text('8. Yuklashdan oldin hamma qatorlar tekshiriladi va tasdiqlaganingizdan keyingina saqlanadi.')],
    [],
    [text('Namuna (bu varaqdan yuklanmaydi):', true)],
    header,
    [
      text('Lavash'),
      text('Fast food'),
      { value: 28000, type: Number },
      { value: 15000, type: Number },
      text('Standart'),
      text('Tovuq go‘shti, pomidor, sous'),
      text('LAV-01'),
      text(''),
      { value: 10, type: Number },
      text('Ha'),
    ],
    [
      text('Kola'),
      text('Ichimliklar'),
      { value: 10000, type: Number },
      { value: 6000, type: Number },
      text('0.5 L'),
      text(''),
      text(''),
      text(''),
      text(''),
      text('Ha'),
    ],
    [],
    [text('Menyudagi mavjud kategoriyalar:', true)],
    ...(categories.length
      ? categories.map((name) => [text(name)])
      : [[text('Hozircha kategoriya yo‘q — yangilari yaratiladi.')]]),
  ];
  const result = await writeXlsxFile(
    [
      {
        sheet: 'Taomlar',
        data: [header],
        columns: COLUMNS.map((column) => ({ width: column.width })),
      },
      {
        sheet: 'Qo‘llanma',
        data: guide,
        columns: COLUMNS.map((column) => ({ width: column.width })),
      },
    ] as never,
  ).toBuffer();
  return Buffer.from(result as unknown as Uint8Array);
}

const unescapeXml = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Joined text of every <t> inside a fragment (rich text runs included). */
const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => unescapeXml(match[1] ?? ''))
    .join('');

const columnIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

/** Rows of the first sheet as text cells; null when the file is not a readable .xlsx. */
export function readFirstSheet(bytes: Uint8Array): string[][] | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) =>
        file.name === 'xl/workbook.xml' ||
        file.name === 'xl/_rels/workbook.xml.rels' ||
        file.name === 'xl/sharedStrings.xml' ||
        file.name.startsWith('xl/worksheets/'),
    });
  } catch {
    return null;
  }
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : null);
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (!workbook) return null;
  // The first sheet in the workbook's order, wherever its file is.
  const relId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  let target = 'worksheets/sheet1.xml';
  if (relId && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes(`Id="${relId}"`));
    const found = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (found) target = found.replace(/^\/?xl\//, '');
  }
  const sheet = read(`xl/${target.replace(/^\//, '')}`);
  if (!sheet) return null;
  const shared = [
    ...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((match) => textOf(match[1] ?? ''));
  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const number = Number(/\br="(\d+)"/.exec(row[1] ?? '')?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const cell of (row[2] ?? '').matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = raw === '1' ? 'Ha' : 'Yo‘q';
      else if (raw !== undefined) value = unescapeXml(raw);
      cells[ref ? columnIndex(ref) : cells.length] = value.trim();
    }
    rows[number - 1] = Array.from(cells, (value) => value ?? '');
  }
  return Array.from(rows, (row) => row ?? []);
}

export type ImportRow = {
  row: number;
  name: string;
  category: string;
  price: number | null;
  cost: number | null;
  variant: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  prepTimeMinutes: number | null;
  isActive: boolean;
  newCategory: boolean;
  errors: string[];
};

const money = (text: string) => {
  const clean = text.replace(/so['‘’]?m/gi, '').replace(/[\s ,]/g, '');
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? value : Number.NaN;
};

const YES = new Set(['ha', 'yes', '1', 'true', "ko'rinadi", 'bor', '+', 'да']);
const NO = new Set(["yo'q", 'yoq', 'no', '0', 'false', 'yashirilgan', 'yashirin', '-', 'нет']);

/**
 * Reads the filled template and checks every row against the current menu: missing or
 * wrong values, duplicates inside the file and products that already exist.
 */
export function checkRows(
  sheet: string[][],
  menu: {
    categories: { id: string; name: string }[];
    products: { name: string; categoryId: string; sku: string | null; barcode: string | null }[];
  },
): { rows: ImportRow[]; headerFound: boolean } {
  const headerIndex = sheet.findIndex((row) =>
    row.some((cell) => normal(cell ?? '').startsWith('taom nomi')),
  );
  if (headerIndex < 0) return { rows: [], headerFound: false };
  const header = sheet[headerIndex]!.map((cell) => normal(cell ?? ''));
  const position = new Map<ColumnKey, number>();
  for (const column of COLUMNS) {
    const index = header.findIndex((cell) => cell.startsWith(column.match));
    if (index >= 0) position.set(column.key, index);
  }
  const categoryByName = new Map(
    menu.categories.map((category) => [normal(category.name), category]),
  );
  const existing = new Set(
    menu.products.map(
      (product) => `${normal(product.name)}|${product.categoryId}`,
    ),
  );
  const skus = new Set(menu.products.flatMap((p) => (p.sku ? [p.sku.toLowerCase()] : [])));
  const barcodes = new Set(menu.products.flatMap((p) => (p.barcode ? [p.barcode] : [])));
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  sheet.slice(headerIndex + 1).forEach((cells, offset) => {
    const get = (key: ColumnKey) => (cells[position.get(key) ?? -1] ?? '').trim();
    if (COLUMNS.every((column) => !get(column.key))) return;
    const errors: string[] = [];
    const name = get('name');
    const category = get('category');
    if (!name) errors.push('errName');
    if (!category) errors.push('errCategory');
    if (name.length > 120 || category.length > 80) errors.push('errLong');
    const price = money(get('price'));
    if (price === null || !Number.isInteger(price) || price <= 0 || price > 1_000_000_000)
      errors.push('errPrice');
    const cost = money(get('cost'));
    if (cost !== null && (!Number.isInteger(cost) || cost < 0 || cost > 1_000_000_000))
      errors.push('errCost');
    const visibleText = normal(get('visible'));
    let isActive = true;
    if (visibleText) {
      if (YES.has(visibleText)) isActive = true;
      else if (NO.has(visibleText)) isActive = false;
      else errors.push('errVisible');
    }
    const prepText = get('prep');
    const prep = prepText ? Number(prepText.replace(',', '.')) : null;
    if (prep !== null && (!Number.isInteger(prep) || prep < 0 || prep > 600))
      errors.push('errPrep');
    const sku = get('sku') || null;
    if (sku && (sku.length > 40 || skus.has(sku.toLowerCase()))) errors.push('errSku');
    const barcode = get('barcode') || null;
    if (barcode && (!/^[0-9A-Za-z-]{4,32}$/.test(barcode) || barcodes.has(barcode)))
      errors.push('errBarcode');
    const description = get('description') || null;
    const variant = get('variant') || 'Standart';
    if ((description?.length ?? 0) > 1000 || variant.length > 60) errors.push('errLong');
    const known = categoryByName.get(normal(category));
    const key = `${normal(name)}|${normal(category)}`;
    if (name && category) {
      if (seen.has(key)) errors.push('errDupFile');
      else if (known && existing.has(`${normal(name)}|${known.id}`))
        errors.push('errDupMenu');
      seen.add(key);
    }
    // Later rows must not reuse an identifier taken by an earlier row of the file.
    if (sku) skus.add(sku.toLowerCase());
    if (barcode) barcodes.add(barcode);
    rows.push({
      row: headerIndex + offset + 2,
      name,
      category,
      price: price !== null && Number.isFinite(price) ? price : null,
      cost: cost !== null && Number.isFinite(cost) ? cost : null,
      variant,
      description,
      sku,
      barcode,
      prepTimeMinutes: prep !== null && Number.isFinite(prep) ? prep : null,
      isActive,
      newCategory: !!category && !known,
      errors: [...new Set(errors)],
    });
  });
  return { rows, headerFound: true };
}
