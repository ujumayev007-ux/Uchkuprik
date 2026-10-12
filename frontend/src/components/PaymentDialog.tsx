import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { newKey, type Order, type PaymentMethod } from '../lib/orders';
import { Button, Dialog, FormError, MoneyField, TextField } from './ui';

const QUICK_CASH = [50_000, 100_000, 200_000];

/**
 * Collects one or more payments for an order. Totals, change and the remaining due
 * always come from the server response; the dialog never decides an order is paid.
 */
export function PaymentDialog({
  order,
  onClose,
  onPaid,
}: {
  order: Order;
  onClose: () => void;
  onPaid: (order: Order, change: number | null) => void;
}) {
  const client = useQueryClient();
  const [current, setCurrent] = useState(order);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState<number | null>(order.due);
  const [tendered, setTendered] = useState<number | null>(order.due);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  // One idempotency key per attempt; retries after a network error reuse it.
  const key = useRef(newKey());

  useEffect(() => {
    setAmount(current.due);
    setTendered(current.due);
  }, [current.due]);

  // Loyalty points of the attached customer (1 point = 1 so‘m).
  const customer = useQuery({
    queryKey: ['customers', current.customerId],
    queryFn: () =>
      api<{ customer: { points: number } }>(`/customers/${current.customerId}`),
    enabled: !!current.customerId,
  });
  const points = customer.data?.customer.points ?? 0;
  // Each method starts from what it can cover: points up to the balance, else the full due.
  useEffect(() => {
    setAmount(
      method === 'LOYALTY' ? Math.min(points, current.due) : current.due,
    );
  }, [method, points, current.due]);
  const change =
    method === 'CASH' && tendered !== null && amount !== null
      ? tendered - amount
      : 0;

  const submit = async () => {
    if (!amount) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ change: number | null; order: Order }>(
        `/orders/${current.id}/payments`,
        {
          idempotencyKey: key.current,
          method,
          amount,
          ...(method === 'CASH' ? { tendered: tendered ?? 0 } : {}),
          ...(method === 'CARD' && reference.trim()
            ? { reference: reference.trim() }
            : {}),
        },
      );
      key.current = newKey();
      await client.invalidateQueries({ queryKey: ['shift'] });
      await client.invalidateQueries({ queryKey: ['customers'] });
      await client.invalidateQueries({ queryKey: ['orders'] });
      if (result.order.due === 0) onPaid(result.order, result.change);
      else {
        setCurrent(result.order);
        setPartial(true);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`${t.payment.title} · ${t.orders.number}${current.number}`}
      onClose={onClose}
      wide
    >
      <div className="payment">
        <div className="payment-summary">
          <div>
            <span>{t.pos.total}</span>
            <strong>{formatMoney(current.total)}</strong>
          </div>
          {current.paidTotal - current.refundedTotal > 0 && (
            <div>
              <span>{t.pos.paid}</span>
              <strong>
                {formatMoney(current.paidTotal - current.refundedTotal)}
              </strong>
            </div>
          )}
          <div className="due">
            <span>{t.pos.due}</span>
            <strong>{formatMoney(current.due)}</strong>
          </div>
        </div>
        {partial && <p className="notice">{t.payment.partial}</p>}
        <div
          className="segmented"
          role="radiogroup"
          aria-label={t.payment.title}
        >
          {(current.customerId
            ? (['CASH', 'CARD', 'LOYALTY'] as const)
            : (['CASH', 'CARD'] as const)
          ).map((value) => (
            <button
              key={value}
              role="radio"
              aria-checked={method === value}
              className={method === value ? 'active' : ''}
              onClick={() => setMethod(value)}
            >
              {t.payment.methods[value]}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <MoneyField
            label={`${t.payment.amount} (${t.menu.sum})`}
            value={amount}
            onChange={setAmount}
            required
          />
          {method === 'CASH' ? (
            <MoneyField
              label={`${t.payment.received} (${t.menu.sum})`}
              value={tendered}
              onChange={setTendered}
              required
            />
          ) : method === 'LOYALTY' ? (
            <p className="notice">
              {t.crm.points}: <strong>{points}</strong>
            </p>
          ) : (
            <TextField
              label={`${t.payment.reference} (${t.common.optional})`}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
        </div>
        {method === 'CASH' && (
          <>
            <div className="quick-cash">
              <Button onClick={() => setTendered(amount)}>
                {t.payment.exact}
              </Button>
              {QUICK_CASH.filter((value) => value >= (amount ?? 0)).map(
                (value) => (
                  <Button key={value} onClick={() => setTendered(value)}>
                    {formatMoney(value)}
                  </Button>
                ),
              )}
            </div>
            <div
              className={`change ${change < 0 ? 'negative' : ''}`}
              role="status"
            >
              <span>{t.payment.change}</span>
              <strong>{formatMoney(Math.max(0, change))}</strong>
            </div>
          </>
        )}
        <p className="muted small">{t.payment.onlineLater}</p>
        <FormError error={error} />
        <Button
          variant="primary"
          size="lg"
          className="block-button"
          busy={busy}
          disabled={
            !amount ||
            amount > current.due ||
            (method === 'CASH' && change < 0) ||
            (method === 'LOYALTY' && amount > points)
          }
          onClick={() => void submit()}
        >
          {t.payment.confirm}
        </Button>
      </div>
    </Dialog>
  );
}
