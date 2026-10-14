import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';

type CourierOrder = {
  id: string;
  number: number;
  status: string;
  deliveryStatus: 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'FAILED';
  address: string | null;
  landmark?: string | null;
  customerName: string | null;
  customerPhone: string | null;
  note: string | null;
  total: number;
  due: number;
  items: { name: string; quantity: number }[];
  deliveredAt: string | null;
};

/** Sends the device position every 30 s while the courier has consented and the page is open. */
function useLocationSharing(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return;
    let last = 0;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        if (Date.now() - last < 30_000) return;
        last = Date.now();
        void post('/courier/location', {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }).catch(() => undefined);
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [enabled]);
}

export function CourierPage() {
  const client = useQueryClient();
  const toast = useToast();
  const data = useQuery({
    queryKey: ['orders', 'courier'],
    queryFn: () =>
      api<{ locationConsent: boolean; orders: CourierOrder[] }>(
        '/courier/orders',
      ),
    refetchInterval: 20_000,
  });
  const [dialog, setDialog] = useState<{
    order: CourierOrder;
    kind: 'deliver' | 'fail';
  } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  useLocationSharing(!!data.data?.locationConsent);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ['orders', 'courier'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };

  if (data.isPending) return <LoadingState />;
  if (data.error)
    return (
      <ErrorState error={data.error} onRetry={() => void data.refetch()} />
    );
  const active = data.data.orders.filter(
    (order) => order.deliveryStatus !== 'DELIVERED',
  );
  return (
    <div className="courier">
      <h1>{t.delivery.courierTitle}</h1>
      <div className="card">
        <Checkbox
          label={t.delivery.shareLocation}
          description={t.delivery.shareLocationHint}
          checked={data.data.locationConsent}
          onChange={(consent) =>
            void act(() =>
              api('/courier/consent', { method: 'PUT', body: { consent } }),
            )
          }
        />
      </div>
      {active.length === 0 ? (
        <EmptyState title={t.delivery.noDeliveries} />
      ) : (
        active.map((order) => (
          <article
            key={order.id}
            className="card courier-card"
            aria-label={`${t.orders.number}${order.number}`}
          >
            <header className="track-line">
              <strong className="ticket-number">
                {t.orders.number}
                {order.number}
              </strong>
              <Badge
                tone={order.deliveryStatus === 'FAILED' ? 'danger' : 'accent'}
              >
                {t.delivery.statuses[order.deliveryStatus]}
              </Badge>
            </header>
            <p className="courier-address">{order.address}</p>
            {order.landmark && (
              <p className="muted">
                📍 {t.deliverySheet.landmark}: {order.landmark}
              </p>
            )}
            <p className="muted">{order.customerName}</p>
            {order.note && <p className="ticket-note">{order.note}</p>}
            <ul className="plain-list small">
              {order.items.map((item, index) => (
                <li key={index}>
                  {item.quantity} × {item.name}
                </li>
              ))}
            </ul>
            <div className={`change ${order.due > 0 ? '' : 'paid'}`}>
              <span>
                {order.due > 0 ? t.delivery.collect : t.delivery.paid}
              </span>
              <strong>{formatMoney(order.due)}</strong>
            </div>
            <div className="courier-actions">
              {order.customerPhone && (
                <a
                  className="btn btn-secondary btn-lg"
                  href={`tel:${order.customerPhone.replace(/[^\d+]/g, '')}`}
                >
                  {t.delivery.call}
                </a>
              )}
              {order.address && (
                <a
                  className="btn btn-secondary btn-lg"
                  href={`https://yandex.uz/maps/?text=${encodeURIComponent(order.address)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.delivery.route}
                </a>
              )}
              {(order.deliveryStatus === 'ASSIGNED' ||
                order.deliveryStatus === 'FAILED') && (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() =>
                    void act(() => post(`/courier/orders/${order.id}/pickup`))
                  }
                >
                  {t.delivery.pickup}
                </Button>
              )}
              {order.deliveryStatus === 'PICKED_UP' && (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    setText('');
                    setError(null);
                    setDialog({ order, kind: 'deliver' });
                  }}
                >
                  {t.delivery.deliver}
                </Button>
              )}
              {order.deliveryStatus !== 'FAILED' && (
                <Button
                  variant="danger"
                  size="lg"
                  onClick={() => {
                    setText('');
                    setError(null);
                    setDialog({ order, kind: 'fail' });
                  }}
                >
                  {t.delivery.problem}
                </Button>
              )}
            </div>
          </article>
        ))
      )}
      <Dialog
        open={dialog !== null}
        title={
          dialog?.kind === 'deliver' ? t.delivery.deliver : t.delivery.problem
        }
        onClose={() => setDialog(null)}
      >
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!dialog) return;
            setError(null);
            try {
              await post(
                `/courier/orders/${dialog.order.id}/${dialog.kind === 'deliver' ? 'deliver' : 'fail'}`,
                dialog.kind === 'deliver' ? { proof: text } : { reason: text },
              );
              setDialog(null);
              await client.invalidateQueries({
                queryKey: ['orders', 'courier'],
              });
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <TextField
            label={
              dialog?.kind === 'deliver' ? t.delivery.proof : t.delivery.reason
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            minLength={dialog?.kind === 'deliver' ? 2 : 3}
            required
            autoFocus
          />
          <FormError error={error} />
          <Button type="submit" variant="primary" size="lg">
            {t.common.confirm}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
