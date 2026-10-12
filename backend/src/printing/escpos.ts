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
    return this.line(char.repeat(COLUMNS));
  }
  /** Left and right text on one line, padded to the paper width. */
  pair(left: string, right: string, columns = COLUMNS) {
    const l = toPrintable(left);
    const r = toPrintable(right);
    const space = Math.max(1, columns - l.length - r.length);
    return this.line(
      `${l.slice(0, columns - r.length - 1)}${' '.repeat(space)}${r}`,
    );
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
  items: {
    quantity: number;
    name: string;
    modifiers: string[];
    note: string | null;
  }[];
};

export function kitchenTicket(ticket: KitchenTicket): Uint8Array<ArrayBuffer> {
  const time = new Intl.DateTimeFormat('uz-UZ', {
    timeZone: ticket.timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(ticket.createdAt);
  const doc = new EscPos().align('center');
  if (ticket.stationName) doc.line(ticket.stationName.toUpperCase());
  if (ticket.priority > 0)
    doc.bold(true).line('*** SHOSHILINCH ***').bold(false);
  doc.size(2, 2).bold(true).line(`N ${ticket.number}`).size(1, 1).bold(false);
  doc.line(
    `${ticket.typeLabel}${ticket.table ? ` - ${ticket.table}` : ''} - ${time}`,
  );
  doc.align('left').rule();
  for (const item of ticket.items) {
    doc
      .size(1, 2)
      .bold(true)
      .line(`${item.quantity} x ${item.name}`)
      .size(1, 1)
      .bold(false);
    for (const modifier of item.modifiers) doc.line(`   + ${modifier}`);
    if (item.note) doc.line(`   ! ${item.note}`);
  }
  if (ticket.note) doc.rule().line(`Izoh: ${ticket.note}`);
  return doc.rule().feed(4).cut().build();
}
