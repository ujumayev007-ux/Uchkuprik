import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import {
  displayCell,
  type Column,
  type ReportDoc,
  type SectionDoc,
} from '../document.js';

const require = createRequire(import.meta.url);
// A font with Latin and Cyrillic coverage (dish names may use either alphabet).
const REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const MARGIN = 40;
const PAD = 4;

/** A PDF with the same sections as the Excel and Word files, paginated with page numbers. */
export function toPdf(doc: ReportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wide = doc.sections.some((section) => section.columns.length > 5);
    const pdf = new PDFDocument({
      size: 'A4',
      layout: wide ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: doc.title, Author: 'FastFood' },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.registerFont('regular', REGULAR);
    pdf.registerFont('bold', BOLD);

    const width = () => pdf.page.width - 2 * MARGIN;
    const bottom = () => pdf.page.height - MARGIN - 20;

    pdf.font('bold').fontSize(18).text(doc.title);
    pdf.font('regular').fontSize(10).moveDown(0.3);
    pdf.text(`Restoran: ${doc.restaurant}`);
    pdf.text(doc.filters.join(' · '));
    pdf.text(`Tayyorlangan: ${doc.generatedAt}`);
    for (const note of doc.notes)
      pdf.fillColor('#555555').text(note).fillColor('#000000');
    if (doc.sections.length === 0)
      pdf.moveDown().text('Ko‘rsatiladigan bo‘lim yo‘q.');

    const widthsFor = (columns: Column[]) => {
      const total = width();
      const first = Math.round(total * (columns.length > 2 ? 0.3 : 0.55));
      const rest = (total - first) / Math.max(1, columns.length - 1);
      return columns.map((_, index) => (index === 0 ? first : rest));
    };

    const drawRow = (
      widths: number[],
      texts: string[],
      options: { bold?: boolean; fill?: string } = {},
    ) => {
      pdf.font(options.bold ? 'bold' : 'regular').fontSize(9);
      const height =
        Math.max(
          ...texts.map((text, index) =>
            pdf.heightOfString(text, { width: widths[index]! - 2 * PAD }),
          ),
          11,
        ) +
        2 * PAD;
      return { height };
    };

    const paint = (
      columns: Column[],
      widths: number[],
      texts: string[],
      y: number,
      height: number,
      options: { bold?: boolean; fill?: string },
    ) => {
      let x = MARGIN;
      if (options.fill) pdf.rect(MARGIN, y, width(), height).fill(options.fill);
      pdf
        .fillColor('#000000')
        .font(options.bold ? 'bold' : 'regular')
        .fontSize(9);
      texts.forEach((text, index) => {
        pdf.text(text, x + PAD, y + PAD, {
          width: widths[index]! - 2 * PAD,
          align: columns[index]!.align === 'right' ? 'right' : 'left',
        });
        x += widths[index]!;
      });
      pdf
        .moveTo(MARGIN, y + height)
        .lineTo(MARGIN + width(), y + height)
        .strokeColor('#CCCCCC')
        .lineWidth(0.5)
        .stroke();
      // Each cell moved the text cursor: back to the row start and the left margin,
      // so the caller advances by exactly one row and the next title starts at the margin.
      pdf.x = MARGIN;
      pdf.y = y;
    };

    const table = (section: SectionDoc) => {
      if (pdf.y + 60 > bottom()) pdf.addPage();
      pdf.moveDown(0.8).font('bold').fontSize(12).text(section.title);
      pdf.moveDown(0.3);
      const { columns } = section;
      const widths = widthsFor(columns);
      const header = columns.map((column) => column.label);
      const rows: { texts: string[]; bold?: boolean; fill?: string }[] = [
        ...section.rows.map((row) => ({
          texts: columns.map((column) => displayCell(column, row[column.key])),
        })),
      ];
      if (rows.length === 0)
        rows.push({
          texts: ['Ma’lumot yo‘q', ...columns.slice(1).map(() => '')],
        });
      const totals = section.totals;
      if (totals)
        rows.push({
          texts: columns.map((column) =>
            displayCell(column, totals[column.key]),
          ),
          bold: true,
          fill: '#F4F1EA',
        });
      const drawHeader = () => {
        const { height } = drawRow(widths, header, { bold: true });
        paint(columns, widths, header, pdf.y, height, {
          bold: true,
          fill: '#E8E4DA',
        });
        pdf.y += height;
      };
      drawHeader();
      for (const row of rows) {
        const { height } = drawRow(widths, row.texts, {
          bold: row.bold ?? false,
        });
        if (pdf.y + height > bottom()) {
          pdf.addPage();
          drawHeader();
        }
        paint(columns, widths, row.texts, pdf.y, height, {
          bold: row.bold ?? false,
          ...(row.fill ? { fill: row.fill } : {}),
        });
        pdf.y += height;
      }
      if (section.note)
        pdf
          .moveDown(0.3)
          .font('regular')
          .fontSize(8)
          .fillColor('#555555')
          .text(section.note, MARGIN, pdf.y, { width: width() })
          .fillColor('#000000');
    };

    pdf.moveDown(0.5);
    for (const section of doc.sections) table(section);

    // Page numbers once the page count is known.
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      const margins = pdf.page.margins;
      const old = margins.bottom;
      margins.bottom = 0;
      pdf
        .font('regular')
        .fontSize(8)
        .fillColor('#777777')
        .text(
          `Sahifa ${i + 1} / ${range.count}`,
          MARGIN,
          pdf.page.height - 30,
          {
            width: width(),
            align: 'center',
            lineBreak: false,
          },
        );
      margins.bottom = old;
    }
    pdf.end();
  });
}
