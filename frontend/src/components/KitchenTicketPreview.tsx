import type { ReactNode } from 'react';
import type { ReceiptLayout } from '../lib/receipt';

/** Parts of a kitchen ticket, as the server prints them (escpos.ts KITCHEN_BLOCKS). */
export const KITCHEN_BLOCKS = [
  'header',
  'alerts',
  'station',
  'number',
  'meta',
  'items',
  'note',
  'footer',
] as const;
export type KitchenBlock = (typeof KITCHEN_BLOCKS)[number];

export function kitchenBlockOrder(chosen: readonly string[]): KitchenBlock[] {
  const known = chosen.filter((name): name is KitchenBlock =>
    (KITCHEN_BLOCKS as readonly string[]).includes(name),
  );
  const unique = [...new Set(known)];
  return [
    ...unique,
    ...KITCHEN_BLOCKS.filter((name) => !unique.includes(name)),
  ];
}

const SEPARATOR: Record<string, string> = {
  single: '-',
  dashed: '-',
  double: '=',
  stars: '*',
  heavy: '#',
};

/**
 * Preview of a kitchen ticket in the designer, drawn like the thermal printout (one
 * monospaced column per printed character).
 */
export function KitchenTicketPreview({ layout }: { layout: ReceiptLayout }) {
  const columns = layout.widthMm <= 60 ? 32 : 48;
  const rule = (SEPARATOR[layout.separatorStyle] ?? '-').repeat(columns);
  const itemSize =
    layout.kitchenItemSize ?? (layout.largeItems ? 'tall' : 'normal');
  const order = layout.layoutOrder
    ? kitchenBlockOrder(layout.layoutOrder)
    : KITCHEN_BLOCKS;
  const on = (value: boolean | undefined) => value !== false;
  const meta = [
    ...(on(layout.showOrderType) ? ['Zalda'] : []),
    ...(on(layout.showTable) ? ['5-stol'] : []),
    ...(on(layout.showDateTime) ? ['14:05'] : []),
  ].join(' - ');
  const parts: Record<KitchenBlock, ReactNode> = {
    header: layout.title ? (
      <div className="kp-center kp-bold">{layout.title}</div>
    ) : null,
    alerts: null,
    station: on(layout.showStation) ? (
      <div className="kp-center">KABOB</div>
    ) : null,
    number: on(layout.showOrderNumber) ? (
      <div
        className={`kp-center kp-bold ${layout.kitchenLargeNumber === false ? '' : 'kp-big'}`}
      >
        N 17
      </div>
    ) : null,
    meta: (
      <>
        {meta && <div className="kp-center">{meta}</div>}
        {on(layout.showWaiter) && (
          <div className="kp-center">Ofitsiant: Ali</div>
        )}
        <div>{rule}</div>
      </>
    ),
    items: (
      <>
        {[
          { name: '2 x Shashlik', extra: '+ Piyoz', note: 'Achchiq' },
          { name: '1 x Lavash', extra: null, note: null },
        ].map((item) => (
          <div key={item.name}>
            <div className={`kp-bold kp-item-${itemSize}`}>{item.name}</div>
            {item.extra && on(layout.showModifiers) && (
              <div>{`   ${item.extra}`}</div>
            )}
            {item.note && on(layout.showNotes) && (
              <div>{`   ! ${item.note}`}</div>
            )}
          </div>
        ))}
      </>
    ),
    note: on(layout.showNotes) ? (
      <>
        <div>{rule}</div>
        <div>Izoh: Tezroq</div>
      </>
    ) : null,
    footer: (
      <>
        {layout.extraLines && (
          <>
            <div>{rule}</div>
            {layout.extraLines.split('\n').map((line) => (
              <div key={line} className="kp-center">
                {line}
              </div>
            ))}
          </>
        )}
        {layout.thankYou && (
          <>
            <div>{rule}</div>
            <div className="kp-center">{layout.thankYou}</div>
          </>
        )}
      </>
    ),
  };
  return (
    <div
      className="kitchen-preview"
      style={{
        width: `${columns + 2}ch`,
        fontSize: layout.fontSize === 'small' ? 11 : 13,
      }}
    >
      <style>{`.kitchen-preview{font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;background:#fff;color:#000;padding:8px;box-shadow:0 2px 10px #0002;line-height:1.25}
.kitchen-preview .kp-center{text-align:center}.kitchen-preview .kp-bold{font-weight:700}
.kitchen-preview .kp-big{font-size:2em;line-height:1.1}.kitchen-preview .kp-item-tall{transform:scaleY(1.8);transform-origin:top;margin-bottom:.8em}
.kitchen-preview .kp-item-big{font-size:2em;line-height:1.1}`}</style>
      {order.map((block) => (
        <div key={block}>{parts[block]}</div>
      ))}
      <div>{rule}</div>
    </div>
  );
}
