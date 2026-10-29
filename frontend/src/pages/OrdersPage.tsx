import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { can, useMe } from '../auth/session';
import { DisplayModeSwitch, OrderBoard } from '../components/OrderBoard';
import { TableAssignDialog } from '../components/TableAssignDialog';
import { PaymentDialog } from '../components/PaymentDialog';
import { PrintReceipt } from '../components/PrintReceipt';
import {
  ScheduleDialog,
  ScheduledOrders,
  schedulingOn,
  useActiveWorkflow,
} from '../components/ScheduledOrders';
import {
  printForKitchen,
  receiptAfterPayment,
} from '../components/TerminalPrinter';
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
import { api, patch, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { useOrderDisplayMode, useOrdering } from '../lib/ordering';
import type { Order, OrderItem, OrderStatus } from '../lib/orders';
import { formatOrderNo } from '../lib/uzbek-number';

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

export function StatusBadge({
  status,
  scheduledFor,
}: {
  status: OrderStatus;
  scheduledFor?: string | null | undefined;
}) {
  // A banquet / scheduled order waiting for its time (not for the cashier).
  if (status === 'PENDING' && scheduledFor)
    return <Badge tone="accent">{t.orders.statuses.SCHEDULED}</Badge>;
  return <Badge tone={tone[status]}>{t.orders.statuses[status]}</Badge>;
}

/**
 * Payment state, independent of the kitchen status: an order can be ready and
 * unpaid, or paid before cooking starts.
 */
export function PaymentBadge({
  order,
}: {
  order: { total: number; due: number; status: OrderStatus };
}) {
  if (order.status === 'CANCELLED' || order.total === 0) return null;
  if (order.due <= 0) return <Badge tone="success">✓ {t.payStatus.paid}</Badge>;
  if (order.due < order.total)
    return (
      <Badge tone="warning">
        {t.payStatus.partial} · {formatMoney(order.due)}
      </Badge>
    );
  return <Badge tone="danger">{t.payStatus.unpaid}</Badge>;
}

type Action = 'cancel' | 'refund' | 'discount' | 'pay' | 'note' | null;

export function OrderDetail({
  orderId,
  onClose,
}: {
  orderId: string;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const ordering = useOrdering();
  const navigate = useNavigate();
  const [tableOpen, setTableOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const workflow = useActiveWorkflow();
  const [note, setNote] = useState<string | null>(null);
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

  // Before sending: edited in place. After sending: a reason is asked and the kitchen
  // gets an updated ticket with the old line crossed out.
  const changeItem = (item: OrderItem, quantity: number) => {
    const o = order.data!;
    const sent = o.status !== 'DRAFT';
    const why = sent ? (window.prompt(t.orderEdit.reason) ?? '') : '';
    if (sent && why.trim().length < 3) return;
    void run(() =>
      patch(`/orders/${o.id}/items/${item.id}`, {
        quantity,
        ...(sent ? { reason: why } : {}),
      }),
    );
  };

  // The item note (e.g. "achchiq bo‘lmasin") is edited the same way.
  const changeNote = (item: OrderItem) => {
    const o = order.data!;
    const text = window.prompt(t.ordering.noteLabel, item.note ?? '');
    if (text === null) return;
    const sent = o.status !== 'DRAFT';
    const why = sent ? (window.prompt(t.orderEdit.reason) ?? '') : '';
    if (sent && why.trim().length < 3) return;
    void run(() =>
      patch(`/orders/${o.id}/items/${item.id}`, {
        note: text.trim() || null,
        ...(sent ? { reason: why } : {}),
      }),
    );
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
        title={`${formatOrderNo(o.number)} · ${t.pos.types[o.type]}`}
        onClose={onClose}
        wide
      >
        <div className="stack">
          <div className="badges">
            <StatusBadge status={o.status} scheduledFor={o.scheduledFor} />{' '}
            <PaymentBadge order={o} />
            {o.scheduledFor && (
              <div className="muted small">
                {t.scheduled.badge.replace(
                  '{at}',
                  formatDateTime(o.scheduledFor),
                )}
                {o.guests ? ` · ${t.scheduled.guests}: ${o.guests}` : ''}
                {o.eventName ? ` · ${o.eventName}` : ''}
              </div>
            )}
            {o.kitchen?.rejectedAt ? (
              <Badge tone="danger">
                {t.orders.kitchenRejected}: {o.kitchen.rejectReason}
              </Badge>
            ) : o.kitchen?.acceptedAt ? (
              <Badge tone="accent">{t.orders.kitchenAccepted}</Badge>
            ) : null}
            {o.table && (
              <Badge>
                {t.pos.table}: {o.table.name}
              </Badge>
            )}
            {!o.table && o.type === 'DINE_IN' && (
              <Badge tone="warning">{t.ordering.noTable}</Badge>
            )}
            <Badge>{formatDateTime(o.createdAt)}</Badge>
            {o.version && o.version > 1 && o.status !== 'DRAFT' && (
              <Badge tone="accent">
                {t.orderEdit.version.replace('{n}', String(o.version))}
              </Badge>
            )}
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
                    {item.note && (
                      <small className="block note">! {item.note}</small>
                    )}
                    {item.cancelRequested && (
                      <Badge tone="warning">⏳ {t.orderEdit.waitingCook}</Badge>
                    )}
                  </td>
                  <td className="right nowrap">
                    {open &&
                    item.status === 'ACTIVE' &&
                    !item.cancelRequested &&
                    o.status !== 'PENDING' ? (
                      <span className="qty-edit">
                        <button
                          className="icon-button"
                          aria-label={t.orderEdit.less}
                          disabled={busy || item.quantity <= 1}
                          onClick={() => changeItem(item, item.quantity - 1)}
                        >
                          −
                        </button>
                        × {item.quantity}
                        <button
                          className="icon-button"
                          aria-label={t.orderEdit.more}
                          disabled={busy}
                          onClick={() => changeItem(item, item.quantity + 1)}
                        >
                          +
                        </button>
                      </span>
                    ) : (
                      <>× {item.quantity}</>
                    )}
                  </td>
                  <td className="right nowrap">
                    {formatMoney(item.lineTotal)}
                  </td>
                  <td className="right nowrap">
                    {open &&
                      item.status === 'ACTIVE' &&
                      !item.cancelRequested &&
                      o.status !== 'PENDING' &&
                      can(me, 'orders.edit') && (
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() => changeNote(item)}
                        >
                          {t.pos.note}
                        </button>
                      )}{' '}
                    {open &&
                      item.status === 'ACTIVE' &&
                      !item.cancelRequested && (
                        <button
                          className="text-link"
                          onClick={() => {
                            const why =
                              o.status === 'DRAFT'
                                ? ''
                                : (window.prompt(t.orders.cancelReason) ?? '');
                            if (o.status !== 'DRAFT' && why.trim().length < 3)
                              return;
                            const cooking =
                              item.kitchenStatus === 'PREPARING' ||
                              item.kitchenStatus === 'READY';
                            const override =
                              cooking &&
                              can(me, 'orders.cancel') &&
                              window.confirm(t.orderEdit.overrideAsk);
                            void run(async () => {
                              const result = await post<{
                                cancelRequested?: boolean;
                              }>(`/orders/${o.id}/items/${item.id}/cancel`, {
                                reason: why,
                                override,
                              });
                              if (result?.cancelRequested)
                                toast(t.orderEdit.requestSent);
                            });
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
          {action === 'note' && (
            <div className="stack card">
              <TextField
                label={t.ordering.noteLabel}
                value={note ?? ''}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
              />
              <Button
                variant="primary"
                busy={busy}
                onClick={() =>
                  void run(() =>
                    patch(`/orders/${o.id}`, {
                      note: (note ?? '').trim() || null,
                    }),
                  )
                }
              >
                {t.common.save}
              </Button>
            </div>
          )}
          {action === 'discount' && (
            <div className="stack card">
              <p className="muted small">
                {t.ordering.discountLimits
                  .replace(
                    '{percent}',
                    String(ordering.discount.maxPercentBp / 100),
                  )
                  .replace('{fixed}', formatMoney(ordering.discount.maxFixed))}
              </p>
              <div className="form-grid">
                <TextField
                  label={t.orders.discountPercent}
                  type="number"
                  min={0}
                  max={ordering.discount.maxPercentBp / 100}
                  disabled={!ordering.discount.percent}
                  hint={
                    ordering.discount.percent
                      ? undefined
                      : t.ordering.percentOff
                  }
                  value={discount.percent}
                  onChange={(e) =>
                    setDiscount({ ...discount, percent: e.target.value })
                  }
                />
                <MoneyField
                  label={`${t.orders.discountFixed} (${t.menu.sum})`}
                  disabled={!ordering.discount.fixed}
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
            <PrintReceipt orderId={o.id} />
            {o.status === 'DRAFT' && (
              <Button
                busy={busy}
                onClick={() => void run(() => post(`/orders/${o.id}/place`))}
              >
                {t.orders.place}
              </Button>
            )}
            {o.workflow?.scheduling &&
              (o.status === 'DRAFT' || o.status === 'PENDING') &&
              can(me, 'orders.edit') && (
                <Button onClick={() => setScheduling(true)}>
                  {o.scheduledFor ? t.scheduled.edit : t.scheduled.set}
                </Button>
              )}
            {open && o.type === 'DINE_IN' && ordering.tableAssign && (
              <Button onClick={() => setTableOpen(true)}>
                {o.table ? t.ordering.changeTable : t.ordering.assignTable}
              </Button>
            )}
            {open && can(me, 'orders.edit') && (
              <Button
                onClick={() => {
                  setNote(o.note ?? '');
                  setAction('note');
                }}
              >
                {t.ordering.editNote}
              </Button>
            )}
            {open &&
              o.status !== 'PENDING' &&
              can(me, 'pos.access') &&
              can(me, 'orders.edit') && (
                <Button
                  onClick={() =>
                    navigate(
                      `/kassa?buyurtma=${o.id}${o.table ? `&stol=${o.table.id}` : ''}`,
                    )
                  }
                >
                  {t.ordering.addItems}
                </Button>
              )}
            {open &&
              can(me, 'discounts.apply') &&
              (ordering.discount.percent || ordering.discount.fixed) && (
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
            {['DRAFT', 'PLACED', 'PREPARING', 'READY', 'SERVED'].includes(
              o.status,
            ) &&
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
                {o.due < o.total ? t.orders.payRemaining : t.payStatus.accept}
              </Button>
            )}
            {o.total > 0 && o.due <= 0 && o.status !== 'CANCELLED' && (
              <Badge tone="success">✓ {t.payStatus.paid}</Badge>
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
      {tableOpen && (
        <TableAssignDialog
          order={o}
          onClose={() => setTableOpen(false)}
          onDone={() => toast(t.ordering.tableSaved)}
        />
      )}
      {scheduling && (
        <ScheduleDialog
          order={o}
          leadMinutes={
            (o.workflow &&
              workflow.data?.zones[o.workflow.zone]?.scheduleLeadMinutes) ??
            30
          }
          onClose={() => setScheduling(false)}
        />
      )}
      {action === 'pay' && (
        <PaymentDialog
          order={o}
          onClose={() => setAction(null)}
          onPaid={async () => {
            setAction(null);
            toast(t.payment.done);
            // Kassa application: the receipt (and a kitchen ticket if the payment
            // sent the order to the kitchen) on this terminal's own printers.
            receiptAfterPayment(o.id, toast);
            printForKitchen(o.id, toast);
            await refresh();
          }}
        />
      )}
    </>
  );
}

export function OrdersPage() {
  const { data: me } = useMe();
  const ordering = useOrdering();
  const navigate = useNavigate();
  const view = useOrderDisplayMode();
  const [scope, setScope] = useState<
    'active' | 'today' | 'history' | 'scheduled'
  >('active');
  const workflow = useActiveWorkflow();
  const scheduled = schedulingOn(workflow.data);
  // Order history: business-date range (default: the last 7 days) and a search.
  // Local calendar day (the restaurant's day), not the UTC one.
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  };
  const [range, setRange] = useState({ from: day(-6), to: day(0), q: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Order | null>(null);
  const orders = useQuery({
    queryKey: [
      'orders',
      'list',
      me?.activeBranchId,
      scope,
      scope === 'history' ? range : null,
    ],
    queryFn: () =>
      api<{ orders: Order[] }>(
        scope === 'history'
          ? `/orders?branchId=${me?.activeBranchId}&scope=all&limit=200&from=${range.from}&to=${range.to}${range.q.trim() ? `&q=${encodeURIComponent(range.q.trim())}` : ''}`
          : `/orders?branchId=${me?.activeBranchId}&scope=${scope}`,
      ).then((data) => data.orders),
    enabled: !!me?.activeBranchId && scope !== 'scheduled',
    refetchInterval: 15_000,
  });
  // «Mijoz»: a guest orders at the cashier before choosing a table.
  const canGuest =
    can(me, 'orders.create') &&
    can(me, 'pos.access') &&
    ordering.walkin &&
    ordering.types.DINE_IN;
  const canAssign =
    ordering.tableAssign &&
    (can(me, 'orders.edit') ||
      can(me, 'orders.create') ||
      can(me, 'payments.accept'));
  return (
    <>
      <PageHeader title={t.orders.title} subtitle={t.orders.subtitle} />
      <div className="orders-toolbar">
        <div className="tabs" role="tablist">
          {(['active', 'today', 'history'] as const).map((value) => (
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
          {scheduled && (
            <button
              role="tab"
              aria-selected={scope === 'scheduled'}
              className={`tab ${scope === 'scheduled' ? 'active' : ''}`}
              onClick={() => setScope('scheduled')}
            >
              {t.scheduled.tab}
            </button>
          )}
        </div>
        {scope === 'history' && (
          <>
            <TextField
              label={t.orders.from}
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
            <TextField
              label={t.orders.to}
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
            <TextField
              label={t.orders.search}
              type="search"
              value={range.q}
              onChange={(e) => setRange({ ...range, q: e.target.value })}
            />
          </>
        )}
        <span className="spacer" />
        {view.canChange && (
          <DisplayModeSwitch mode={view.mode} onChange={view.change} />
        )}
        {canGuest && (
          <Button
            variant="primary"
            size="lg"
            title={t.ordering.guestHint}
            onClick={() => navigate('/kassa?mijoz=1')}
          >
            + {t.ordering.guest}
          </Button>
        )}
      </div>
      {scope === 'scheduled' ? (
        <ScheduledOrders onSelect={setSelected} />
      ) : orders.isPending ? (
        <LoadingState />
      ) : orders.error ? (
        <ErrorState
          error={orders.error}
          onRetry={() => void orders.refetch()}
        />
      ) : orders.data.length === 0 ? (
        <EmptyState title={t.orders.noOrders} />
      ) : (
        <OrderBoard
          orders={orders.data}
          mode={view.mode}
          onSelect={(order) => setSelected(order.id)}
          {...(canAssign ? { onAssignTable: setAssigning } : {})}
        />
      )}
      {selected && (
        <OrderDetail orderId={selected} onClose={() => setSelected(null)} />
      )}
      {assigning && (
        <TableAssignDialog
          order={assigning}
          onClose={() => setAssigning(null)}
        />
      )}
    </>
  );
}
