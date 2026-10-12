import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { PaymentDialog } from '../components/PaymentDialog';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import type { Order, OrderStatus } from '../lib/orders';

const tone: Record<
  OrderStatus,
  'neutral' | 'success' | 'warning' | 'danger' | 'accent'
> = {
  DRAFT: 'neutral',
  PENDING: 'warning',
  PLACED: 'accent',
  PREPARING: 'warning',
  READY: 'success',
  SERVED: 'success',
  COMPLETED: 'neutral',
  CANCELLED: 'danger',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={tone[status]}>{t.orders.statuses[status]}</Badge>;
}

type Action = 'cancel' | 'refund' | 'discount' | 'pay' | null;

function OrderDetail({
  orderId,
  onClose,
}: {
  orderId: string;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const order = useQuery({
    queryKey: ['orders', 'one', orderId],
    queryFn: () => api<Order>(`/orders/${orderId}`),
  });
  const events = useQuery({
    queryKey: ['orders', 'events', orderId],
    queryFn: () =>
      api<{
        events: {
          id: string;
          type: string;
          actor: string | null;
          createdAt: string;
          data: Record<string, unknown> | null;
        }[];
      }>(`/orders/${orderId}/events`).then((data) => data.events),
  });
  const [action, setAction] = useState<Action>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<{
    paymentId: string;
    amount: number | null;
  }>({ paymentId: '', amount: null });
  const [discount, setDiscount] = useState<{
    percent: string;
    fixed: number | null;
  }>({ percent: '', fixed: null });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['orders'] });
    await client.invalidateQueries({ queryKey: ['shift'] });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAction(null);
      setReason('');
      toast(t.common.saved);
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (order.isPending)
    return (
      <Dialog open title={t.orders.details} onClose={onClose}>
        <LoadingState />
      </Dialog>
    );
  if (order.error)
    return (
      <Dialog open title={t.orders.details} onClose={onClose}>
        <ErrorState error={order.error} />
      </Dialog>
    );
  const o = order.data;
  const open = !['COMPLETED', 'CANCELLED'].includes(o.status);
  const refundable = o.payments.map((payment) => ({
    ...payment,
    left:
      payment.amount -
      o.refunds
        .filter((r) => r.paymentId === payment.id)
        .reduce((sum, r) => sum + r.amount, 0),
  }));

  return (
    <>
      <Dialog
        open={action !== 'pay'}
        title={`${t.orders.number}${o.number} · ${t.pos.types[o.type]}`}
        onClose={onClose}
        wide
      >
        <div className="stack">
          <div className="badges">
            <StatusBadge status={o.status} />
            {o.table && (
              <Badge>
                {t.pos.table}: {o.table.name}
              </Badge>
            )}
            <Badge>{formatDateTime(o.createdAt)}</Badge>
          </div>
          {(o.customerName || o.customerPhone || o.deliveryAddress) && (
            <p className="muted">
              {[o.customerName, o.customerPhone, o.deliveryAddress]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <table className="table compact">
            <tbody>
              {o.items.map((item) => (
                <tr
                  key={item.id}
                  className={item.status === 'CANCELLED' ? 'is-inactive' : ''}
                >
                  <td>
                    <strong>{item.productName}</strong>{' '}
                    <span className="muted">{item.variantName}</span>
                    {item.modifiers.length > 0 && (
                      <small className="muted block">
                        {item.modifiers.map((m) => m.name).join(', ')}
                      </small>
                    )}
                    {item.status === 'CANCELLED' && (
                      <small className="block">
                        {t.orders.cancelled}: {item.cancelReason}
                      </small>
                    )}
                  </td>
                  <td className="right nowrap">× {item.quantity}</td>
                  <td className="right nowrap">
                    {formatMoney(item.lineTotal)}
                  </td>
                  <td className="right">
                    {open &&
                      item.status === 'ACTIVE' &&
                      (o.status === 'DRAFT' || can(me, 'orders.cancel')) && (
                        <button
                          className="text-link"
                          onClick={() => {
                            const why =
                              o.status === 'DRAFT'
                                ? ''
                                : (window.prompt(t.orders.cancelReason) ?? '');
                            if (o.status !== 'DRAFT' && why.trim().length < 3)
                              return;
                            void run(() =>
                              post(`/orders/${o.id}/items/${item.id}/cancel`, {
                                reason: why,
                              }),
                            );
                          }}
                        >
                          {t.orders.cancelItem}
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="totals">
            <dt>{t.pos.subtotal}</dt>
            <dd>{formatMoney(o.subtotal)}</dd>
            {o.discountTotal > 0 && (
              <>
                <dt>
                  {t.pos.discount}{' '}
                  {o.discountReason && (
                    <small className="muted">({o.discountReason})</small>
                  )}
                </dt>
                <dd>−{formatMoney(o.discountTotal)}</dd>
              </>
            )}
            {o.serviceCharge > 0 && (
              <>
                <dt>
                  {t.pos.serviceCharge} ({o.serviceChargeBp / 100}%)
                </dt>
                <dd>{formatMoney(o.serviceCharge)}</dd>
              </>
            )}
            <dt className="strong">{t.pos.total}</dt>
            <dd className="strong">{formatMoney(o.total)}</dd>
            <dt>{t.pos.paid}</dt>
            <dd>{formatMoney(o.paidTotal - o.refundedTotal)}</dd>
            <dt className="strong">{t.pos.due}</dt>
            <dd className="strong">{formatMoney(o.due)}</dd>
          </dl>
          {o.payments.length > 0 && (
            <section>
              <h3 className="section-title">{t.orders.payments}</h3>
              <ul className="plain-list">
                {o.payments.map((payment) => (
                  <li key={payment.id}>
                    {t.payment.methods[payment.method]} ·{' '}
                    {formatMoney(payment.amount)}
                    {payment.change
                      ? ` (${t.payment.change}: ${formatMoney(payment.change)})`
                      : ''}
                    <span className="muted">
                      {' '}
                      · {formatDateTime(payment.createdAt)}
                    </span>
                  </li>
                ))}
                {o.refunds.map((refundRow) => (
                  <li key={refundRow.id} className="danger-text">
                    {t.orders.refund}: {t.payment.methods[refundRow.method]} · −
                    {formatMoney(refundRow.amount)} · {refundRow.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {events.data && (
            <details>
              <summary>{t.orders.history}</summary>
              <ul className="plain-list small">
                {events.data.map((event) => (
                  <li key={event.id}>
                    {formatDateTime(event.createdAt)} ·{' '}
                    {t.orders.events[event.type] ?? event.type}
                    {event.type === 'status' && event.data?.to
                      ? `: ${t.orders.statuses[event.data.to as OrderStatus]}`
                      : ''}
                    {event.actor && (
                      <span className="muted"> · {event.actor}</span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {action === 'cancel' && (
            <div className="stack card">
              <TextField
                label={t.orders.cancelReason}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                required
                autoFocus
              />
              <Button
                variant="danger"
                busy={busy}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void run(() => post(`/orders/${o.id}/cancel`, { reason }))
                }
              >
                {t.common.confirm}
              </Button>
            </div>
          )}
          {action === 'discount' && (
            <div className="stack card">
              <div className="form-grid">
                <TextField
                  label={t.orders.discountPercent}
                  type="number"
                  min={0}
                  max={100}
                  value={discount.percent}
                  onChange={(e) =>
                    setDiscount({ ...discount, percent: e.target.value })
                  }
                />
                <MoneyField
                  label={`${t.orders.discountFixed} (${t.menu.sum})`}
                  value={discount.fixed}
                  onChange={(fixed) => setDiscount({ ...discount, fixed })}
                />
              </div>
              <TextField
                label={t.orders.discountReason}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant="primary"
                busy={busy}
                onClick={() =>
                  void run(() =>
                    post(`/orders/${o.id}/discount`, {
                      percentBp: Math.round(
                        Number(discount.percent || 0) * 100,
                      ),
                      fixed: discount.fixed ?? 0,
                      reason,
                    }),
                  )
                }
              >
                {t.orders.applyDiscount}
              </Button>
            </div>
          )}
          {action === 'refund' && (
            <div className="stack card">
              <p className="muted small">{t.orders.refundHint}</p>
              <SelectField
                label={t.orders.payments}
                value={refund.paymentId}
                onChange={(e) =>
                  setRefund({ ...refund, paymentId: e.target.value })
                }
              >
                <option value="">—</option>
                {refundable
                  .filter((payment) => payment.left > 0)
                  .map((payment) => (
                    <option key={payment.id} value={payment.id}>
                      {t.payment.methods[payment.method]} ·{' '}
                      {formatMoney(payment.left)}
                    </option>
                  ))}
              </SelectField>
              <MoneyField
                label={`${t.orders.refundAmount} (${t.menu.sum})`}
                value={refund.amount}
                onChange={(amount) => setRefund({ ...refund, amount })}
                required
              />
              <TextField
                label={t.orders.refundReason}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                required
              />
              <Button
                variant="danger"
                busy={busy}
                disabled={
                  !refund.paymentId ||
                  !refund.amount ||
                  reason.trim().length < 3
                }
                onClick={() =>
                  void run(() =>
                    post(`/orders/${o.id}/refunds`, {
                      paymentId: refund.paymentId,
                      amount: refund.amount,
                      reason,
                    }),
                  )
                }
              >
                {t.orders.refund}
              </Button>
            </div>
          )}
          <FormError error={error} />
          <div className="form-actions">
            <Button
              onClick={() =>
                window.open(
                  `/chek/${o.id}`,
                  '_blank',
                  'noopener,width=420,height=700',
                )
              }
            >
              {t.payment.printReceipt}
            </Button>
            {o.status === 'DRAFT' && (
              <Button
                busy={busy}
                onClick={() => void run(() => post(`/orders/${o.id}/place`))}
              >
                {t.orders.place}
              </Button>
            )}
            {open && can(me, 'discounts.apply') && (
              <Button
                onClick={() =>
                  setAction(action === 'discount' ? null : 'discount')
                }
              >
                {t.orders.applyDiscount}
              </Button>
            )}
            {can(me, 'payments.refund') && o.paidTotal > o.refundedTotal && (
              <Button
                variant="danger"
                onClick={() => setAction(action === 'refund' ? null : 'refund')}
              >
                {t.orders.refund}
              </Button>
            )}
            {['DRAFT', 'PLACED'].includes(o.status) &&
              can(me, 'orders.cancel') && (
                <Button
                  variant="danger"
                  onClick={() =>
                    setAction(action === 'cancel' ? null : 'cancel')
                  }
                >
                  {t.orders.cancel}
                </Button>
              )}
            {open && o.due > 0 && can(me, 'payments.accept') && (
              <Button variant="primary" onClick={() => setAction('pay')}>
                {t.orders.payRemaining}
              </Button>
            )}
            {open &&
              o.status !== 'DRAFT' &&
              o.due === 0 &&
              can(me, 'orders.edit') && (
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() =>
                    void run(() => post(`/orders/${o.id}/complete`))
                  }
                >
                  {t.orders.complete}
                </Button>
              )}
          </div>
        </div>
      </Dialog>
      {action === 'pay' && (
        <PaymentDialog
          order={o}
          onClose={() => setAction(null)}
          onPaid={async () => {
            setAction(null);
            toast(t.payment.done);
            await refresh();
          }}
        />
      )}
    </>
  );
}

export function OrdersPage() {
  const { data: me } = useMe();
  const [scope, setScope] = useState<'active' | 'today'>('active');
  const [selected, setSelected] = useState<string | null>(null);
  const orders = useQuery({
    queryKey: ['orders', 'list', me?.activeBranchId, scope],
    queryFn: () =>
      api<{ orders: Order[] }>(
        `/orders?branchId=${me?.activeBranchId}&scope=${scope}`,
      ).then((data) => data.orders),
    enabled: !!me?.activeBranchId,
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title={t.orders.title} subtitle={t.orders.subtitle} />
      <div className="tabs" role="tablist">
        {(['active', 'today'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={scope === value}
            className={`tab ${scope === value ? 'active' : ''}`}
            onClick={() => setScope(value)}
          >
            {t.orders[value]}
          </button>
        ))}
      </div>
      {orders.isPending ? (
        <LoadingState />
      ) : orders.error ? (
        <ErrorState
          error={orders.error}
          onRetry={() => void orders.refetch()}
        />
      ) : orders.data.length === 0 ? (
        <EmptyState title={t.orders.noOrders} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.orders.number}</th>
                <th>{t.orders.type}</th>
                <th>{t.common.status}</th>
                <th>{t.orders.time}</th>
                <th className="right">{t.pos.total}</th>
                <th className="right">{t.pos.due}</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((order) => (
                <tr
                  key={order.id}
                  className="clickable"
                  onClick={() => setSelected(order.id)}
                >
                  <td>
                    <button
                      className="text-link"
                      onClick={() => setSelected(order.id)}
                    >
                      {t.orders.number}
                      {order.number}
                    </button>
                  </td>
                  <td>
                    {t.pos.types[order.type]}
                    {order.table && (
                      <small className="muted block">{order.table.name}</small>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={order.status} />
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
      )}
      {selected && (
        <OrderDetail orderId={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
