import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { useBusy } from '../lib/busy';
import { formatMoney } from '../lib/format';
import { newKey, type Order, type PaymentMethod } from '../lib/orders';
import { QrPayPanel, useQrPayment } from './QrPayPanel';
import {
  Button,
  Dialog,
  FormError,
  MoneyField,
  SelectField,
  TextField,
} from './ui';

type CreditAccount = {
  id: string;
  label: string;
  balance: number;
  available: number | null;
};

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
  // Taking a payment is never interrupted.
  useBusy('payment');
  const [current, setCurrent] = useState(order);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState<number | null>(order.due);
  const [tendered, setTendered] = useState<number | null>(order.due);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [accountQuery, setAccountQuery] = useState('');
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
  // Merchant QR (Paynet etc.), when the owner enabled it.
  const qr = useQrPayment();
  const qrEnabled = !!qr.data?.enabled;
  // Nasiya / hotel room bill: only where the order's workflow allows credit.
  const creditAllowed = current.workflow?.payment === 'CREDIT';
  const accounts = useQuery({
    queryKey: ['credit-accounts', 'open', accountQuery],
    queryFn: () =>
      api<{ accounts: CreditAccount[] }>(
        `/credit-accounts?open=true${accountQuery.trim() ? `&q=${encodeURIComponent(accountQuery.trim())}` : ''}`,
      ).then((data) => data.accounts),
    enabled: creditAllowed && method === 'CREDIT',
  });
  const account = accounts.data?.find((item) => item.id === accountId);
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
          ...((method === 'CARD' || method === 'QR') && reference.trim()
            ? { reference: reference.trim() }
            : {}),
          ...(method === 'CREDIT' ? { creditAccountId: accountId } : {}),
        },
      );
      key.current = newKey();
      await client.invalidateQueries({ queryKey: ['shift'] });
      await client.invalidateQueries({ queryKey: ['customers'] });
      await client.invalidateQueries({ queryKey: ['credit-accounts'] });
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
          {(
            [
              'CASH',
              'CARD',
              ...(qrEnabled ? (['QR'] as const) : []),
              ...(current.customerId ? (['LOYALTY'] as const) : []),
              ...(creditAllowed ? (['CREDIT'] as const) : []),
            ] as const
          ).map((value) => (
            <button
              key={value}
              role="radio"
              aria-checked={method === value}
              className={method === value ? 'active' : ''}
              onClick={() => setMethod(value)}
            >
              {value === 'QR' && qr.data?.label
                ? qr.data.label
                : t.payment.methods[value]}
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
          ) : method === 'CREDIT' ? (
            <div className="stack">
              <TextField
                label={t.payment.creditSearch}
                type="search"
                value={accountQuery}
                onChange={(e) => setAccountQuery(e.target.value)}
              />
              {accounts.data?.length === 0 ? (
                <p className="muted small">{t.payment.creditNone}</p>
              ) : (
                <SelectField
                  label={t.payment.creditAccount}
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">{t.payment.creditPick}</option>
                  {accounts.data?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {formatMoney(item.balance)}
                    </option>
                  ))}
                </SelectField>
              )}
              {account && (
                <p className="muted small">
                  {account.available === null
                    ? t.payment.creditNoLimit
                    : t.payment.creditAvailable.replace(
                        '{n}',
                        formatMoney(account.available),
                      )}
                </p>
              )}
            </div>
          ) : (
            <TextField
              label={
                method === 'QR'
                  ? `${t.qrPay.reference}${qr.data?.requireReference ? '' : ` (${t.common.optional})`}`
                  : `${t.payment.reference} (${t.common.optional})`
              }
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
        </div>
        {method === 'QR' && qr.data && (
          <QrPayPanel qr={qr.data} amount={amount ?? 0} />
        )}
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
            (method === 'LOYALTY' && amount > points) ||
            (method === 'CREDIT' &&
              (!account ||
                (account.available !== null && amount > account.available))) ||
            (method === 'QR' &&
              !!qr.data?.requireReference &&
              !reference.trim())
          }
          onClick={() => void submit()}
        >
          {t.payment.confirm}
        </Button>
      </div>
    </Dialog>
  );
}
