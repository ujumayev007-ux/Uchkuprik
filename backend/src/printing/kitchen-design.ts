import { kitchenTicket, type KitchenTicket } from './escpos.js';
import {
  columnsForWidth,
  type ReceiptTemplateSettings,
} from './receipt-template.js';
import type { TicketTemplate } from './template.js';

const SEPARATOR: Record<ReceiptTemplateSettings['separatorStyle'], string> = {
  single: '-',
  dashed: '-',
  double: '=',
  stars: '*',
  heavy: '#',
};

/**
 * A kitchen ticket laid out by a named KITCHEN template from the receipt designer:
 * texts, visible fields, sizes and the order of its parts. A department's own simple
 * layout (header, footer, large items…) is the base it changes.
 */
export function kitchenLayoutOf(
  custom: ReceiptTemplateSettings,
  station: TicketTemplate,
): NonNullable<KitchenTicket['template']> & { copies: number } {
  return {
    ...station,
    header: custom.title || station.header,
    footer: custom.thankYou || station.footer,
    largeItems: custom.largeItems,
    showWaiter: custom.showWaiter,
    showNotes: custom.showNotes,
    design: {
      blocks: custom.layoutOrder,
      showStation: custom.showStation,
      showOrderNumber: custom.showOrderNumber,
      showOrderType: custom.showOrderType,
      showTable: custom.showTable,
      showDateTime: custom.showDateTime,
      showModifiers: custom.showModifiers,
      itemSize:
        custom.kitchenItemSize ?? (custom.largeItems ? 'tall' : 'normal'),
      largeNumber: custom.kitchenLargeNumber,
      smallFont: custom.fontSize === 'small',
      separator: SEPARATOR[custom.separatorStyle],
      extraLines: custom.extraLines,
    },
  };
}

/** Sample ticket in a KITCHEN template's settings (designer test print). */
export function sampleKitchenTicket(
  settings: ReceiptTemplateSettings,
  printerName: string,
  now = new Date(),
) {
  return kitchenTicket({
    stationName: 'Kabob',
    number: 123,
    typeLabel: 'Zalda',
    table: 'Stol 5',
    note: `Sinov: ${printerName}`,
    priority: 0,
    createdAt: now,
    timezone: 'Asia/Tashkent',
    waiter: 'Ofitsiant',
    columns: columnsForWidth(
      settings.widthMm,
      settings.marginLeftMm + settings.marginRightMm,
    ),
    template: kitchenLayoutOf(settings, {
      header: '',
      footer: '',
      largeItems: true,
      showWaiter: true,
      showNotes: true,
      copies: 1,
    }),
    items: [
      {
        quantity: 2,
        name: 'Shashlik (qo‘y)',
        modifiers: ['Piyoz'],
        note: 'Achchiq',
      },
      { quantity: 1, name: 'Lavash', modifiers: [], note: null },
    ],
  });
}
