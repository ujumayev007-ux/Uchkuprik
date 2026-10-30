import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Order } from '../lib/orders';
import { chime } from '../lib/realtime';
import { Button, useToast } from './ui';

/**
 * Online orders waiting for approval, shown above every staff screen for holders of
 * orders.approve. Updates live through the real-time order events.
 */
export function PendingOrders({ branchId }: { branchId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const pending = useQuery({
    queryKey: ['orders', 'pending', branchId],
    queryFn: () =>
      api<{ orders: Order[] }>(
        `/orders?branchId=${branchId}&scope=active`,
      ).then((data) =>
        data.orders.filter(
          // A confirmed banquet / scheduled order waits for its time, not for approval.
          (order) => order.status === 'PENDING' && !order.scheduleConfirmedAt,
        ),
      ),
    refetchInterval: 30_000,
  });
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const count = pending.data?.length ?? 0;
    if (seen.current !== null && count > seen.current) {
      chime();
      setOpen(true);
    }
    seen.current = count;
  }, [pending.data]);

  if (!pending.data || pending.data.length === 0) return null;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ['orders'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <section className="pending-orders" aria-live="polite">
      <button
        className="pending-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="pending-count">{pending.data.length}</span>
        {t.online.pendingOrders}
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul>
          {pending.data.map((order) => (
            <li key={order.id}>
              <div>
                <strong>
                  {t.orders.number}
                  {order.number}
                </strong>{' '}
                · {t.online.channels[order.channel] ?? order.channel}
                {order.table && ` · ${t.online.table} ${order.table.name}`}
                {order.type === 'DELIVERY' && ` · ${t.pos.types.DELIVERY}`}
                <small className="muted block">
                  {[
                    order.customerName,
                    order.customerPhone,
                    order.deliveryAddress,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <small className="block">
                  {order.items
                    .filter((item) => item.status === 'ACTIVE')
                    .map((item) => `${item.quantity}× ${item.productName}`)
                    .join(', ')}{' '}
                  — <strong>{formatMoney(order.total)}</strong>
                </small>
              </div>
              <div className="pending-actions">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    const reason = window.prompt(t.online.rejectReason) ?? '';
                    if (reason.trim().length >= 3)
                      void act(() =>
                        post(`/orders/${order.id}/reject`, { reason }),
                      );
                  }}
                >
                  {t.online.reject}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    void act(() => post(`/orders/${order.id}/approve`))
                  }
                >
                  {t.online.approve}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
