import writeXlsxFile from 'write-excel-file/node';
import {
  displayCell,
  kindOf,
  valueOf,
  type Cell,
  type Column,
  type ReportDoc,
} from '../document.js';

/**
 * Spreadsheet programs run text that starts with = + - @ as a formula. Restaurant data
 * (dish names, notes) is user-typed, so such text is stored with a leading apostrophe.
 */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const sheetName = (title: string, used: Set<string>) => {
  let name =
    title
      .replace(/[[\]:*?/\\]/g, ' ')
      .slice(0, 31)
      .trim() || 'Hisobot';
  for (let i = 2; used.has(name.toLowerCase()); i++)
    name = `${name.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
};

type XlsxCell = Record<string, unknown>;

function cellOf(
  column: Column,
  cell: Cell | undefined,
  bold = false,
): XlsxCell {
  const base = bold ? { fontWeight: 'bold' } : {};
  if (cell === undefined) return { value: '', type: String, ...base };
  const kind = kindOf(column, cell);
  const value = valueOf(cell);
  const numeric =
    typeof value === 'number' ||
    (kind !== 'text' && kind !== 'time' && /^-?\d+(\.\d+)?$/.test(value));
  if (numeric)
    return {
      value: Number(value),
      type: Number,
      // Whole quantities without a trailing separator ("3 000", not "3 000.").
      format:
        kind === 'qty' && !Number.isInteger(Number(value))
          ? '#,##0.###'
          : '#,##0',
      align: 'right',
      ...base,
    };
  return { value: safeText(displayCell(column, cell)), type: String, ...base };
}

/** One sheet per section, each with the report heading, filters and totals. */
export async function toXlsx(doc: ReportDoc): Promise<Buffer> {
  const used = new Set<string>();
  const heading: XlsxCell[][] = [
    [{ value: doc.title, type: String, fontWeight: 'bold', fontSize: 14 }],
    [{ value: `Restoran: ${safeText(doc.restaurant)}`, type: String }],
    [{ value: doc.filters.map(safeText).join(' · '), type: String }],
    [{ value: `Tayyorlangan: ${doc.generatedAt}`, type: String }],
    ...doc.notes.map((note) => [{ value: note, type: String }]),
    [],
  ];
  const sections = doc.sections.length
    ? doc.sections
    : [
        {
          key: 'summary' as const,
          title: 'Hisobot',
          columns: [] as Column[],
          rows: [],
          note: 'Ko‘rsatiladigan bo‘lim yo‘q.',
        },
      ];
  const sheets = sections.map((section) => {
    const data: XlsxCell[][] = [...heading];
    data.push([
      { value: section.title, type: String, fontWeight: 'bold', fontSize: 12 },
    ]);
    if (section.columns.length) {
      data.push(
        section.columns.map((column) => ({
          value: column.label,
          type: String,
          fontWeight: 'bold',
          backgroundColor: '#E8E4DA',
          align: column.align,
        })),
      );
      if (section.rows.length === 0)
        data.push([{ value: 'Ma’lumot yo‘q', type: String }]);
      for (const row of section.rows)
        data.push(
          section.columns.map((column) => cellOf(column, row[column.key])),
        );
      if (section.totals) {
        const totals = section.totals;
        data.push(
          section.columns.map((column) =>
            cellOf(column, totals[column.key], true),
          ),
        );
      }
    }
    if (section.note) data.push([], [{ value: section.note, type: String }]);
    return {
      sheet: sheetName(section.title, used),
      data,
      columns: section.columns.length
        ? section.columns.map((column, index) => ({
            width:
              index === 0
                ? 34
                : Math.max(14, Math.min(40, column.label.length + 6)),
          }))
        : [{ width: 40 }],
    };
  });
  const result = await writeXlsxFile(sheets as never).toBuffer();
  return Buffer.from(result as unknown as Uint8Array);
}
