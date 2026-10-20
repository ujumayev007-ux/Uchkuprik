import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { displayCell, type Column, type ReportDoc } from '../document.js';

const border = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(
  text: string,
  column: Column,
  width: number,
  options: { bold?: boolean; fill?: string } = {},
) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    ...(options.fill
      ? {
          shading: {
            type: ShadingType.CLEAR,
            fill: options.fill,
            color: 'auto',
          },
        }
      : {}),
    children: [
      new Paragraph({
        alignment:
          column.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [
          new TextRun({ text, bold: options.bold === true, size: 18 }),
        ],
      }),
    ],
  });
}

/** A Word document: heading, filters, one table per section, page numbers. */
export async function toDocx(doc: ReportDoc): Promise<Buffer> {
  const wide = doc.sections.some((section) => section.columns.length > 5);
  const pageWidth = wide ? 15840 : 12240; // US Letter in DXA, landscape or portrait
  const usable = pageWidth - 2 * 1000;
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(doc.title)],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Restoran: ${doc.restaurant}`, bold: true }),
      ],
    }),
    new Paragraph({ children: [new TextRun(doc.filters.join(' · '))] }),
    new Paragraph({
      children: [new TextRun(`Tayyorlangan: ${doc.generatedAt}`)],
    }),
    ...doc.notes.map(
      (note) =>
        new Paragraph({
          children: [new TextRun({ text: note, italics: true })],
        }),
    ),
  ];
  if (doc.sections.length === 0)
    children.push(new Paragraph('Ko‘rsatiladigan bo‘lim yo‘q.'));
  for (const section of doc.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 280, after: 100 },
        children: [new TextRun(section.title)],
      }),
    );
    const first = Math.round(
      usable * (section.columns.length > 2 ? 0.34 : 0.55),
    );
    const rest = Math.floor(
      (usable - first) / Math.max(1, section.columns.length - 1),
    );
    const widths = section.columns.map((_, index) =>
      index === 0 ? first : rest,
    );
    const rows = [
      new TableRow({
        tableHeader: true,
        children: section.columns.map((column, index) =>
          cell(column.label, column, widths[index]!, {
            bold: true,
            fill: 'E8E4DA',
          }),
        ),
      }),
      ...section.rows.map(
        (row) =>
          new TableRow({
            cantSplit: true,
            children: section.columns.map((column, index) =>
              cell(
                displayCell(column, row[column.key]),
                column,
                widths[index]!,
              ),
            ),
          }),
      ),
    ];
    if (section.rows.length === 0)
      rows.push(
        new TableRow({
          children: [
            cell('Ma’lumot yo‘q', section.columns[0]!, widths[0]!),
            ...section.columns
              .slice(1)
              .map((column, index) => cell('', column, widths[index + 1]!)),
          ],
        }),
      );
    if (section.totals) {
      const totals = section.totals;
      rows.push(
        new TableRow({
          children: section.columns.map((column, index) =>
            cell(
              displayCell(column, totals[column.key]),
              column,
              widths[index]!,
              {
                bold: true,
                fill: 'F4F1EA',
              },
            ),
          ),
        }),
      );
    }
    children.push(
      new Table({
        width: { size: usable, type: WidthType.DXA },
        columnWidths: widths,
        rows,
      }),
    );
    if (section.note)
      children.push(
        new Paragraph({
          spacing: { before: 80 },
          children: [
            new TextRun({ text: section.note, italics: true, size: 18 }),
          ],
        }),
      );
  }
  const document = new Document({
    creator: 'FastFood',
    title: doc.title,
    sections: [
      {
        properties: {
          page: {
            size: {
              width: 12240,
              height: 15840,
              orientation: wide
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [
                      'Sahifa ',
                      PageNumber.CURRENT,
                      ' / ',
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
