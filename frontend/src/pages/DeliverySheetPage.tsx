import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { ErrorState, LoadingState } from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import type { Order } from '../lib/orders';

/**
 * Courier handoff sheet: the only printout with the customer's contact and address
 * (kitchen tickets never show them). Opened by staff who manage deliveries.
 */
export function DeliverySheetPage() {
  const { id } = useParams();
  const order = useQuery({
    queryKey: ['orders', id, 'sheet'],
    queryFn: () =>
      api<Order & { deliveryLandmark?: string | null }>(`/orders/${id}`),
  });
  useEffect(() => {
    if (!order.isSuccess) return;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [order.isSuccess]);
  if (order.isPending) return <LoadingState />;
  if (order.error) return <ErrorState error={order.error} />;
  const o = order.data;
  const d = t.deliverySheet;
  return (
    <div className="receipt">
      <h1 className="center">! DOSTAVKA !</h1>
      <p className="center">
        <strong>
          {t.orders.number}
          {o.number}
        </strong>{' '}
        · {formatDateTime(o.createdAt)}
      </p>
      <hr />
      <p>
        <strong>{d.customer}:</strong> {o.customerName ?? '—'}
      </p>
      <p>
        <strong>{d.phone}:</strong> {o.customerPhone ?? '—'}
      </p>
      <p>
        <strong>{d.address}:</strong> {o.deliveryAddress ?? '—'}
      </p>
      {o.deliveryLandmark && (
        <p>
          <strong>{d.landmark}:</strong> {o.deliveryLandmark}
        </p>
      )}
      {o.note && (
        <p>
          <strong>{d.note}:</strong> {o.note}
        </p>
      )}
      <hr />
      <table className="table compact">
        <tbody>
          {o.items
            .filter((item) => item.status === 'ACTIVE')
            .map((item) => (
              <tr key={item.id}>
                <td>
                  {item.quantity} × {item.productName}
                  {item.variantName !== 'Standart' && ` (${item.variantName})`}
                </td>
                <td className="right">{formatMoney(item.lineTotal)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <hr />
      <p className="pair">
        <span>{t.pos.total}</span>
        <strong>{formatMoney(o.total)}</strong>
      </p>
      <p className="pair">
        <span>{d.collect}</span>
        <strong>{o.due > 0 ? formatMoney(o.due) : d.paid}</strong>
      </p>
      <p className="muted small">{d.signature}</p>
    </div>
  );
}
