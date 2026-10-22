import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ErrorState, LoadingState } from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { Order, OrderItem } from '../lib/orders';
import { formatOrderNo } from '../lib/uzbek-number';

// Kitchen ticket printed by the Kassa application on its own kitchen printer. The
// application says what was printed before (?printed=&cancelled=&known=1&since=), the
// page shows only what the kitchen has not seen yet and reports it back in data-*.

type Line = {
  id: string;
  quantity: number;
  name: string;
  extras: string[];
  note: string | null;
};

const toLine = (item: OrderItem): Line => ({
  id: item.id,
  quantity: item.quantity,
  name: `${item.productName}${item.variantName === 'Standart' ? '' : ` (${item.variantName})`}`,
  extras: [
    ...item.modifiers.map((modifier) => `+ ${modifier.name}`),
    ...(item.components ?? []).map((part) => `${part.quantity}× ${part.name}`),
  ],
  note: item.note,
});

const css = (widthMm: number) => `
@page { size: ${widthMm}mm auto; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.kitchen-ticket { width: ${widthMm}mm; box-sizing: border-box; padding: 2mm 3mm 4mm;
  color: #000; font-family: Arial, 'Segoe UI', sans-serif; font-size: ${widthMm === 58 ? 12 : 14}px; }
.kitchen-ticket .kt-title { text-align: center; font-weight: 700; letter-spacing: 1px; }
.kitchen-ticket .kt-number { text-align: center; font-size: ${widthMm === 58 ? 30 : 38}px; font-weight: 800; line-height: 1.1; margin: 1mm 0; }
.kitchen-ticket .kt-banner { text-align: center; font-weight: 800; border: 2px solid #000; padding: 1mm; margin: 1.5mm 0; }
.kitchen-ticket .kt-meta { display: flex; justify-content: space-between; gap: 2mm; flex-wrap: wrap; font-weight: 600; }
.kitchen-ticket hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.kitchen-ticket .kt-item { margin: 1.5mm 0; }
.kitchen-ticket .kt-name { font-size: ${widthMm === 58 ? 15 : 18}px; font-weight: 800; }
.kitchen-ticket .kt-extra { padding-left: 4mm; }
.kitchen-ticket .kt-note { padding-left: 4mm; font-style: italic; font-weight: 700; }
.kitchen-ticket .kt-gone .kt-name { text-decoration: line-through; }
.kitchen-ticket .kt-foot { text-align: center; font-size: 11px; margin-top: 2mm; }
`;

const widthOf = (params: URLSearchParams) =>
  Number(params.get('width')) === 58 ? 58 : 80;

function Ticket({
  widthMm,
  number,
  meta,
  banner,
  fresh,
  gone,
  note,
  data,
}: {
  widthMm: number;
  number: string;
  meta: string[];
  banner: string | null;
  fresh: Line[];
  gone: Line[];
  note: string | null;
  data: Record<string, string>;
}) {
  const text = t.kitchenTicket;
  const item = (line: Line) => (
    <div key={line.id} className="kt-item">
      <div className="kt-name">
        {line.quantity} × {line.name}
      </div>
      {line.extras.map((extra) => (
        <div key={extra} className="kt-extra">
          {extra}
        </div>
      ))}
      {line.note && (
        <div className="kt-note">
          {text.note}: {line.note}
        </div>
      )}
    </div>
  );
  return (
    <>
      <style>{css(widthMm)}</style>
      <div
        className="kitchen-ticket"
        {...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [`data-${key}`, value]),
        )}
      >
        <div className="kt-title">{text.title}</div>
        <div className="kt-number">{number}</div>
        {banner && <div className="kt-banner">{banner}</div>}
        <div className="kt-meta">
          {meta.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
        <hr />
        {fresh.map(item)}
        {gone.length > 0 && (
          <>
            <div className="kt-banner">{text.removed}</div>
            <div className="kt-gone">{gone.map(item)}</div>
          </>
        )}
        {note && (
          <>
            <hr />
            <div className="kt-note">
              {text.orderNote}: {note}
            </div>
          </>
        )}
        <hr />
        <div className="kt-foot">
          {text.printedAt}: {formatDateTime(new Date().toISOString())}
        </div>
      </div>
    </>
  );
}

export function KitchenTicketPage() {
  const { id } = useParams();
  const params = new URLSearchParams(window.location.search);
  const order = useQuery({
    queryKey: ['kitchen-ticket', id],
    queryFn: () => api<Order>(`/orders/${id}`),
    retry: 1,
  });
  // Only the categories the kitchen prepares («Fast Food»); null = every item.
  const filter = useQuery({
    queryKey: ['kitchen-filter'],
    queryFn: () => api<{ variantIds: string[] | null }>('/kitchen/filter'),
    retry: 1,
  });
  if (order.isPending || filter.isPending) return <LoadingState />;
  if (order.error) return <ErrorState error={order.error} />;
  if (filter.error) return <ErrorState error={filter.error} />;
  const kitchenIds = filter.data.variantIds
    ? new Set(filter.data.variantIds)
    : null;
  const o = {
    ...order.data,
    items: order.data.items.filter(
      (item) => !kitchenIds || kitchenIds.has(item.variantId),
    ),
  };
  const list = (key: string) =>
    new Set((params.get(key) ?? '').split(',').filter(Boolean));
  const printed = list('printed');
  const cancelled = list('cancelled');
  const since = params.get('since');
  const active = o.items.filter((item) => item.status === 'ACTIVE');
  const placedAt = o.placedAt ?? o.createdAt;
  let fresh: OrderItem[] = [];
  let gone: OrderItem[] = [];
  let baseline = false;
  if (o.status === 'DRAFT' || o.status === 'PENDING') {
    // Not sent to the kitchen yet.
  } else if (
    params.get('known') !== '1' &&
    (!since || new Date(placedAt) < new Date(since))
  ) {
    // Placed before automatic printing was switched on here: remembered, not printed.
    baseline = true;
  } else if (o.status === 'CANCELLED') {
    gone = o.items.filter(
      (item) => printed.has(item.id) && !cancelled.has(item.id),
    );
  } else {
    fresh = active.filter((item) => !printed.has(item.id));
    gone = o.items.filter(
      (item) =>
        item.status === 'CANCELLED' &&
        printed.has(item.id) &&
        !cancelled.has(item.id),
    );
  }
  const print = !baseline && (fresh.length > 0 || gone.length > 0);
  const text = t.kitchenTicket;
  const banner =
    o.status === 'CANCELLED'
      ? text.orderCancelled
      : printed.size > 0
        ? text.update
        : null;
  return (
    <Ticket
      widthMm={widthOf(params)}
      number={formatOrderNo(o.number)}
      meta={[
        t.pos.types[o.type],
        ...(o.table ? [`${t.pos.table}: ${o.table.name}`] : []),
        formatDateTime(placedAt),
      ]}
      banner={banner}
      fresh={fresh.map(toLine)}
      gone={gone.map(toLine)}
      note={o.note}
      data={{
        print: print ? '1' : '0',
        number: String(o.number),
        fresh: (baseline ? active : fresh).map((item) => item.id).join(','),
        gone: (baseline
          ? o.items.filter((item) => item.status === 'CANCELLED')
          : gone
        )
          .map((item) => item.id)
          .join(','),
      }}
    />
  );
}

/** Test ticket from the printer settings (sample data, nothing is remembered). */
export function KitchenTicketTestPage() {
  const params = new URLSearchParams(window.location.search);
  const text = t.kitchenTicket;
  return (
    <Ticket
      widthMm={widthOf(params)}
      number={text.testNumber}
      meta={[t.pos.types.TAKEAWAY, formatDateTime(new Date().toISOString())]}
      banner={text.test}
      fresh={[
        {
          id: 'a',
          quantity: 2,
          name: 'Lavash (Katta)',
          extras: ['+ Pishloq'],
          note: 'Achchiq bo‘lmasin',
        },
        { id: 'b', quantity: 1, name: 'Coca-Cola 0,5', extras: [], note: null },
      ]}
      gone={[]}
      note={null}
      data={{ print: '1', number: '0', fresh: '', gone: '' }}
    />
  );
}
