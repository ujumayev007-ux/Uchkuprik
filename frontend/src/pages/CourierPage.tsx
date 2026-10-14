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
import { useOrderSettings } from './OrderSettingsCard';

type CourierOrder = {
  id: string;
  number: number;
  status: string;
  deliveryStatus:
    'ASSIGNED' | 'PICKED_UP' | 'ON_THE_WAY' | 'DELIVERED' | 'FAILED';
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
  const [cash, setCash] = useState('');
  const [handoff, setHandoff] = useState<{
    number: number;
    code: string;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const settings = useOrderSettings();
  // Two-stage codes unless the restaurant turned them off.
  const codes = settings.data?.settings.deliveryCodes ?? true;
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
                order.deliveryStatus === 'FAILED') &&
                (codes ? (
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() =>
                      void act(async () => {
                        const result = await post<{ code: string }>(
                          `/courier/orders/${order.id}/handoff-code`,
                        );
                        setHandoff({ number: order.number, code: result.code });
                      })
                    }
                  >
                    🔐 {t.courierCodes.getHandoff}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() =>
                      void act(() => post(`/courier/orders/${order.id}/pickup`))
                    }
                  >
                    {t.delivery.pickup}
                  </Button>
                ))}
              {order.deliveryStatus === 'PICKED_UP' && codes && (
                <Button
                  size="lg"
                  onClick={() =>
                    void act(() =>
                      post(`/courier/orders/${order.id}/on-the-way`),
                    )
                  }
                >
                  🚚 {t.courierCodes.onTheWay}
                </Button>
              )}
              {(order.deliveryStatus === 'PICKED_UP' ||
                order.deliveryStatus === 'ON_THE_WAY') && (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => {
                    setText('');
                    setCash(order.due > 0 ? String(order.due) : '');
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
                dialog.kind === 'fail'
                  ? { reason: text }
                  : codes
                    ? {
                        code: text.replace(/\D/g, ''),
                        cashCollected: Number(cash.replace(/\D/g, '') || 0),
                      }
                    : { proof: text },
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
          {dialog?.kind === 'deliver' && codes && (
            <p className="muted small">{t.courierCodes.askCustomer}</p>
          )}
          <TextField
            label={
              dialog?.kind === 'deliver'
                ? codes
                  ? t.courierCodes.customerCode
                  : t.delivery.proof
                : t.delivery.reason
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            {...(dialog?.kind === 'deliver' && codes
              ? { inputMode: 'numeric' as const, pattern: '\\d{6}' }
              : {})}
            minLength={dialog?.kind === 'deliver' ? (codes ? 6 : 2) : 3}
            required
            autoFocus
          />
          {dialog?.kind === 'deliver' && codes && dialog.order.due > 0 && (
            <TextField
              label={t.courierCodes.cashCollected}
              inputMode="numeric"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
            />
          )}
          <FormError error={error} />
          <Button type="submit" variant="primary" size="lg">
            {t.common.confirm}
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={handoff !== null}
        title={`${t.courierCodes.handoffTitle} · №${handoff?.number ?? ''}`}
        onClose={() => setHandoff(null)}
      >
        <div className="stack center">
          <p className="handoff-code">{handoff?.code}</p>
          <p className="muted">{t.courierCodes.showCashier}</p>
          <Button variant="primary" size="lg" onClick={() => setHandoff(null)}>
            {t.common.close}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
