import { Badge } from './ui';
import { t } from '../i18n';
import { formatDateTime, formatMoney } from '../lib/format';
import type { DisplayMode } from '../lib/ordering';
import type { Order } from '../lib/orders';
import { formatOrderNo } from '../lib/uzbek-number';
import { PaymentBadge, StatusBadge } from '../pages/OrdersPage';

type Props = {
  orders: Order[];
  mode: DisplayMode;
  onSelect: (order: Order) => void;
  // Shown on orders without a table when the user may assign one.
  onAssignTable?: ((order: Order) => void) | undefined;
};

const tableLabel = (order: Order) =>
  order.table?.name ??
  (order.type === 'DINE_IN' ? t.ordering.noTable : t.pos.types[order.type]);

/** Segmented control that switches between the three order display modes. */
export function DisplayModeSwitch({
  mode,
  onChange,
}: {
  mode: DisplayMode;
  onChange: (mode: DisplayMode) => void;
}) {
  return (
    <div
      className="segmented display-mode"
      role="radiogroup"
      aria-label={t.ordering.view.label}
    >
      {(['compact', 'detailed', 'grid'] as const).map((value) => (
        <button
          key={value}
          role="radio"
          aria-checked={mode === value}
          className={mode === value ? 'active' : ''}
          onClick={() => onChange(value)}
        >
          {t.ordering.view[value]}
        </button>
      ))}
    </div>
  );
}

function AssignLink({
  order,
  onAssignTable,
}: {
  order: Order;
  onAssignTable?: ((order: Order) => void) | undefined;
}) {
  if (!onAssignTable || order.table || order.type !== 'DINE_IN') return null;
  return (
    <button
      className="btn btn-secondary btn-sm"
      onClick={(event) => {
        event.stopPropagation();
        onAssignTable(order);
      }}
    >
      {t.ordering.assignTable}
    </button>
  );
}

/**
 * Orders of the Cashier and Waiter panels in the mode the restaurant chose:
 * compact (table and receipt number), detailed (full information) or adaptive
 * cards that resize like the kitchen screen.
 */
export function OrderBoard({ orders, mode, onSelect, onAssignTable }: Props) {
  if (mode === 'compact')
    return (
      <div className="order-compact" role="list">
        {orders.map((order) => (
          <div
            key={order.id}
            role="listitem"
            className={`order-compact-tile ${
              order.table || order.type !== 'DINE_IN' ? '' : 'no-table'
            }`}
          >
            <button
              className="order-compact-main"
              onClick={() => onSelect(order)}
              aria-label={`${formatOrderNo(order.number)} · ${tableLabel(order)}`}
            >
              <strong className="order-compact-table">
                {order.table?.name ??
                  (order.type === 'DINE_IN' ? '—' : t.pos.types[order.type])}
              </strong>
              <span className="order-compact-number">
                {formatOrderNo(order.number)}
              </span>
              {!order.table && order.type === 'DINE_IN' && (
                <span className="order-compact-hint">{t.ordering.noTable}</span>
              )}
            </button>
            <AssignLink order={order} onAssignTable={onAssignTable} />
          </div>
        ))}
      </div>
    );

  if (mode === 'grid')
    return (
      <div className="order-grid" role="list">
        {orders.map((order) => {
          const items = order.items.filter((item) => item.status === 'ACTIVE');
          return (
            <article
              key={order.id}
              role="listitem"
              className={`order-card status-${order.status.toLowerCase()} ${
                order.table || order.type !== 'DINE_IN' ? '' : 'no-table'
              }`}
            >
              <button
                className="order-card-head"
                onClick={() => onSelect(order)}
              >
                <strong>{formatOrderNo(order.number)}</strong>
                <span>{tableLabel(order)}</span>
              </button>
              <div className="badges">
                <StatusBadge
                  status={order.status}
                  scheduledFor={order.scheduledFor}
                />
                <PaymentBadge order={order} />
              </div>
              <ul className="order-card-items">
                {items.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.quantity} × {item.productName}
                      {item.variantName ? ` ${item.variantName}` : ''}
                    </span>
                    {item.note && <small className="note">! {item.note}</small>}
                  </li>
                ))}
                {items.length > 8 && (
                  <li className="muted">+{items.length - 8}</li>
                )}
              </ul>
              <div className="order-card-foot">
                <strong>{formatMoney(order.total)}</strong>
                <span className="muted small">
                  {formatDateTime(order.createdAt)}
                </span>
              </div>
              <AssignLink order={order} onAssignTable={onAssignTable} />
            </article>
          );
        })}
      </div>
    );

  return (
    <div className="table-wrap">
      <table className="table order-table">
        <thead>
          <tr>
            <th>{t.orders.number}</th>
            <th>{t.orders.type}</th>
            <th>{t.common.status}</th>
            <th>{t.payStatus.column}</th>
            <th>{t.orders.time}</th>
            <th className="right">{t.pos.total}</th>
            <th className="right">{t.pos.due}</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr
              key={order.id}
              className="clickable"
              onClick={() => onSelect(order)}
            >
              <td>
                <button
                  className="text-link"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(order);
                  }}
                >
                  {formatOrderNo(order.number)}
                </button>
              </td>
              <td>
                {t.pos.types[order.type]}
                {order.type === 'DINE_IN' && (
                  <small className="muted block">
                    {order.table?.name ?? (
                      <Badge tone="warning">{t.ordering.noTable}</Badge>
                    )}
                  </small>
                )}
                <AssignLink order={order} onAssignTable={onAssignTable} />
              </td>
              <td>
                <StatusBadge
                  status={order.status}
                  scheduledFor={order.scheduledFor}
                />
              </td>
              <td>
                <PaymentBadge order={order} />
              </td>
              <td className="nowrap">{formatDateTime(order.createdAt)}</td>
              <td className="right nowrap">{formatMoney(order.total)}</td>
              <td className="right nowrap">
                {order.due > 0 ? (
                  <strong>{formatMoney(order.due)}</strong>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
