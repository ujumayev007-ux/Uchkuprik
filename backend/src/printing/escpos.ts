// Minimal ESC/POS encoder for 80 mm thermal printers (48 columns in font A).
// Output is plain ASCII: Uzbek Latin apostrophes (o‘, g‘, ’) are mapped to "'"
// because printer code pages rarely contain them.

const ESC = 0x1b;
const GS = 0x1d;
export const COLUMNS = 48;

export function toPrintable(text: string): string {
  return text
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/№/g, 'N')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e\n]/g, '');
}

export class EscPos {
  private chunks: number[] = [ESC, 0x40]; // initialize
  // 48 columns on 80 mm paper, 32 on 58 mm.
  constructor(private readonly columns = COLUMNS) {}

  text(value: string) {
    for (const char of toPrintable(value)) this.chunks.push(char.charCodeAt(0));
    return this;
  }
  line(value = '') {
    return this.text(value).raw(0x0a);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  align(mode: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, mode === 'left' ? 0 : mode === 'center' ? 1 : 2);
  }
  /** Character size multiplier 1-2 in each direction. */
  size(width: 1 | 2, height: 1 | 2) {
    return this.raw(GS, 0x21, ((width - 1) << 4) | (height - 1));
  }
  rule(char = '-') {
    return this.line(char.repeat(this.columns));
  }
  /** Left and right text on one line, padded to the paper width. */
  pair(left: string, right: string, columns = this.columns) {
    const l = toPrintable(left);
    const r = toPrintable(right);
    const space = Math.max(1, columns - l.length - r.length);
    return this.line(
      `${l.slice(0, columns - r.length - 1)}${' '.repeat(space)}${r}`,
    );
  }
  /** Line height in dots (ESC 3). */
  lineSpacing(dots: number) {
    return this.raw(ESC, 0x33, Math.max(0, Math.min(255, dots)));
  }
  /** Smaller letters (font B, 9 dots wide) or the standard font A. */
  smallFont(on: boolean) {
    return this.raw(ESC, 0x4d, on ? 1 : 0);
  }
  /** Left margin and printable width in dots (GS L, GS W). */
  area(leftDots: number, widthDots: number) {
    const left = Math.max(0, Math.min(65535, leftDots));
    const width = Math.max(64, Math.min(65535, widthDots));
    return this.raw(GS, 0x4c, left & 255, left >> 8).raw(
      GS,
      0x57,
      width & 255,
      width >> 8,
    );
  }
  /** Paper feed in dots (ESC J), split into steps of at most 255. */
  feedDots(dots: number) {
    let left = Math.max(0, Math.round(dots));
    while (left > 0) {
      const step = Math.min(255, left);
      this.raw(ESC, 0x4a, step);
      left -= step;
    }
    return this;
  }
  /**
   * A 1-bit image (GS v 0): `widthDots` is a multiple of 8, `data` has widthDots / 8
   * bytes per row, black = 1. Positioned by the current alignment.
   */
  raster(widthDots: number, heightDots: number, data: Uint8Array) {
    const bytesPerRow = widthDots >> 3;
    if (
      widthDots % 8 !== 0 ||
      bytesPerRow < 1 ||
      bytesPerRow > 255 ||
      heightDots < 1 ||
      heightDots > 1023 ||
      data.length !== bytesPerRow * heightDots
    )
      return this;
    this.raw(
      GS,
      0x76,
      0x30,
      0,
      bytesPerRow & 255,
      bytesPerRow >> 8,
      heightDots & 255,
      heightDots >> 8,
    );
    for (const byte of data) this.chunks.push(byte);
    return this;
  }
  feed(lines = 3) {
    return this.raw(ESC, 0x64, lines);
  }
  cut() {
    return this.raw(GS, 0x56, 0x42, 0x00);
  }
  raw(...bytes: number[]) {
    this.chunks.push(...bytes);
    return this;
  }
  build(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.chunks);
  }
}

export type KitchenTicket = {
  stationName: string | null;
  number: number;
  typeLabel: string;
  table: string | null;
  note: string | null;
  priority: number;
  createdAt: Date;
  timezone: string;
  items: KitchenTicketItem[];
  // Delivery orders get a prominent "! DOSTAVKA !" banner.
  delivery?: boolean;
  // Changed order: "DIQQAT! CHEK YANGILANDI", version and removed items.
  update?: boolean;
  version?: number;
  waiter?: string | null;
  changedBy?: string | null;
  changedAt?: Date;
  cancelled?: KitchenTicketItem[];
  // Characters per line (paper width).
  columns?: number;
  // Department template (KitchenStation.ticketTemplate).
  template?: {
    header: string;
    footer: string;
    largeItems: boolean;
    showWaiter: boolean;
    showNotes: boolean;
  };
};

export type KitchenTicketItem = {
  quantity: number;
  name: string;
  modifiers: string[];
  note: string | null;
  // Shown only when the restaurant enabled prices on kitchen tickets.
  price?: number | null;
};

const money = (value: number) =>
  value.toLocaleString('en-US').replace(/,/g, ' ');

export function kitchenTicket(ticket: KitchenTicket): Uint8Array<ArrayBuffer> {
  const clock = (date: Date) =>
    new Intl.DateTimeFormat('uz-UZ', {
      timeZone: ticket.timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  const time = clock(ticket.createdAt);
  const doc = new EscPos(ticket.columns ?? COLUMNS).align('center');
  const layout = ticket.template;
  if (layout?.header) doc.bold(true).line(layout.header).bold(false);
  if (ticket.delivery)
    doc.size(2, 2).bold(true).line('! DOSTAVKA !').size(1, 1).bold(false);
  if (ticket.update)
    doc
      .bold(true)
      .rule('*')
      .line('DIQQAT! CHEK YANGILANDI')
      .rule('*')
      .bold(false);
  if (ticket.stationName) doc.line(ticket.stationName.toUpperCase());
  if (ticket.priority > 0)
    doc.bold(true).line('*** SHOSHILINCH ***').bold(false);
  doc.size(2, 2).bold(true).line(`N ${ticket.number}`).size(1, 1).bold(false);
  if (ticket.version && ticket.version > 1)
    doc.line(`Versiya ${ticket.version}`);
  doc.line(
    `${ticket.typeLabel}${ticket.table ? ` - ${ticket.table}` : ''} - ${time}`,
  );
  if (ticket.waiter && layout?.showWaiter !== false)
    doc.line(`Ofitsiant: ${ticket.waiter}`);
  if (ticket.update && ticket.changedAt)
    doc.line(
      `O'zgartirildi: ${clock(ticket.changedAt)}${ticket.changedBy ? ` - ${ticket.changedBy}` : ''}`,
    );
  doc.align('left').rule();
  if (ticket.cancelled?.length) {
    doc.bold(true).line('OLIB TASHLANDI:').bold(false);
    for (const item of ticket.cancelled) {
      // Thermal printers have no strikethrough: the line is crossed with dashes.
      const text = `${item.quantity} x ${item.name}`;
      doc
        .size(1, 2)
        .line(`--${toPrintable(text).replace(/ /g, '-')}-- BEKOR`)
        .size(1, 1);
    }
    doc.rule();
    if (ticket.items.length)
      doc.bold(true).line("YANGI / QO'SHILDI:").bold(false);
  }
  for (const item of ticket.items) {
    const text = `${item.quantity} x ${item.name}`;
    doc.size(1, layout?.largeItems === false ? 1 : 2).bold(true);
    if (item.price !== undefined && item.price !== null)
      doc.pair(text, money(item.price));
    else doc.line(text);
    doc.size(1, 1).bold(false);
    for (const modifier of item.modifiers) doc.line(`   + ${modifier}`);
    if (item.note && layout?.showNotes !== false) doc.line(`   ! ${item.note}`);
  }
  if (ticket.note && layout?.showNotes !== false)
    doc.rule().line(`Izoh: ${ticket.note}`);
  if (layout?.footer) doc.rule().align('center').line(layout.footer);
  return doc.rule().feed(4).cut().build();
}
