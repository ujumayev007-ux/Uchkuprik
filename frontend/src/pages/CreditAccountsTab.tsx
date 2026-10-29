import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { newKey } from '../lib/orders';

const c = t.credit;

type Account = {
  id: string;
  kind: 'CUSTOMER' | 'HOTEL_ROOM';
  label: string;
  name: string;
  phone: string | null;
  room: string | null;
  creditLimit: number | null;
  balance: number;
  isOpen: boolean;
  checkoutAt: string | null;
  note: string | null;
  updatedAt: string;
};
type Entry = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  orderId: string | null;
  method: string | null;
  note: string | null;
  createdAt: string;
};
const METHODS = [
  'CASH',
  'CARD',
  'CLICK',
  'PAYME',
  'UZUM',
  'QR',
  'OTHER',
] as const;

/**
 * Qarz hisoblari: customer credit (nasiya) and hotel room bills. Orders are charged
 * from the payment dialog; here accounts are opened, paid back and closed.
 */
export function CreditAccountsTab() {
  const { data: me } = useMe();
  const manage = can(me, 'customers.manage');
  const [filter, setFilter] = useState<'true' | 'false' | ''>('true');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['credit-accounts', 'list', filter, query],
    queryFn: () =>
      api<{ accounts: Account[]; totalDebt: number }>(
        `/credit-accounts?${filter ? `open=${filter}&` : ''}q=${encodeURIComponent(query.trim())}`,
      ),
  });
  if (openId)
    return <AccountDetail id={openId} onBack={() => setOpenId(null)} />;
  return (
    <div className="stack">
      <p className="muted small">{c.hint}</p>
      <div className="toolbar">
        <TextField
          label={t.crm.searchHint}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectField
          label={t.common.status}
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="true">{c.open}</option>
          <option value="false">{c.closed}</option>
          <option value="">{c.all}</option>
        </SelectField>
        <span className="spacer" />
        {list.data && (
          <strong>
            {c.totalDebt}: {formatMoney(list.data.totalDebt)}
          </strong>
        )}
        {manage && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            + {c.add}
          </Button>
        )}
      </div>
      {list.isPending ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.accounts.length === 0 ? (
        <EmptyState title={c.none} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.crm.tabs.customers}</th>
                <th>{c.kind}</th>
                <th className="right">{c.balance}</th>
                <th className="right">{c.limitShort}</th>
                <th>{t.common.status}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.accounts.map((account) => (
                <tr
                  key={account.id}
                  className="clickable"
                  onClick={() => setOpenId(account.id)}
                >
                  <td>
                    <strong>{account.label}</strong>
                    {account.phone && (
                      <div className="muted small">{account.phone}</div>
                    )}
                  </td>
                  <td>{c.kinds[account.kind]}</td>
                  <td className="right">{formatMoney(account.balance)}</td>
                  <td className="right">
                    {account.creditLimit === null
                      ? c.noLimit
                      : formatMoney(account.creditLimit)}
                  </td>
                  <td>
                    <Badge tone={account.isOpen ? 'success' : 'neutral'}>
                      {account.isOpen ? c.open : c.closed}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateAccount onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateAccount({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    kind: 'CUSTOMER' as Account['kind'],
    name: '',
    phone: '',
    room: '',
    limit: null as number | null,
    checkout: '',
    note: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open title={c.add} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/credit-accounts', {
              kind: form.kind,
              name: form.name,
              phone: form.phone.trim() || null,
              room: form.room.trim() || null,
              creditLimit: form.limit,
              note: form.note.trim() || null,
              checkoutAt: form.checkout
                ? new Date(`${form.checkout}T12:00:00`).toISOString()
                : null,
            });
            toast(c.created);
            await client.invalidateQueries({ queryKey: ['credit-accounts'] });
            onClose();
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <SelectField
            label={c.kind}
            value={form.kind}
            onChange={(e) =>
              setForm({ ...form, kind: e.target.value as Account['kind'] })
            }
          >
            <option value="CUSTOMER">{c.kinds.CUSTOMER}</option>
            <option value="HOTEL_ROOM">{c.kinds.HOTEL_ROOM}</option>
          </SelectField>
          <TextField
            label={c.name}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            minLength={2}
            required
          />
          <TextField
            label={c.phone}
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          {form.kind === 'HOTEL_ROOM' && (
            <>
              <TextField
                label={c.room}
                value={form.room}
                onChange={(e) => setForm({ ...form, room: e.target.value })}
                required
              />
              <TextField
                label={c.checkout}
                type="date"
                value={form.checkout}
                onChange={(e) => setForm({ ...form, checkout: e.target.value })}
              />
            </>
          )}
          <MoneyField
            label={c.limit}
            value={form.limit}
            onChange={(limit) => setForm({ ...form, limit })}
          />
          <TextField
            label={c.note}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </div>
        <FormError error={error} />
        <div className="form-actions">
          <Button variant="primary" type="submit" busy={busy}>
            {c.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AccountDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: ['credit-accounts', 'one', id],
    queryFn: () =>
      api<{
        account: Account & { entries: Entry[] };
        orders: { id: string; number: number }[];
      }>(`/credit-accounts/${id}`),
  });
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [amount, setAmount] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // One key per repayment attempt: a retry after a network error is not paid twice.
  const key = useRef(newKey());
  if (detail.isPending) return <LoadingState />;
  if (detail.error)
    return (
      <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
    );
  const { account, orders } = detail.data;
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      toast(done);
      await client.invalidateQueries({ queryKey: ['credit-accounts'] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const numberOf = (orderId: string | null) =>
    orders.find((order) => order.id === orderId)?.number;
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="ghost" onClick={onBack}>
          ← {c.back}
        </Button>
      </div>
      <section className="card stack">
        <h2 className="section-title">
          {account.label}{' '}
          <Badge tone={account.isOpen ? 'success' : 'neutral'}>
            {account.isOpen ? c.open : c.closed}
          </Badge>
        </h2>
        <div className="muted small">
          {c.kinds[account.kind]}
          {account.phone && ` · ${account.phone}`}
          {account.checkoutAt &&
            ` · ${c.checkout}: ${formatDateTime(account.checkoutAt)}`}
          {account.note && ` · ${account.note}`}
        </div>
        <div className="payment-summary">
          <div className="due">
            <span>{c.balance}</span>
            <strong>{formatMoney(account.balance)}</strong>
          </div>
          <div>
            <span>{c.limitShort}</span>
            <strong>
              {account.creditLimit === null
                ? c.noLimit
                : formatMoney(account.creditLimit)}
            </strong>
          </div>
        </div>
        {can(me, 'payments.accept') && account.balance > 0 && (
          <div className="form-grid">
            <SelectField
              label={c.repayMethod}
              value={method}
              onChange={(e) =>
                setMethod(e.target.value as (typeof METHODS)[number])
              }
            >
              {METHODS.map((value) => (
                <option key={value} value={value}>
                  {t.payment.methods[value]}
                </option>
              ))}
            </SelectField>
            <MoneyField
              label={c.repayAmount}
              value={amount}
              onChange={setAmount}
            />
            <div className="form-actions">
              <Button
                variant="primary"
                busy={busy}
                disabled={!amount || amount > account.balance}
                onClick={() =>
                  void run(async () => {
                    await post(`/credit-accounts/${id}/repayments`, {
                      idempotencyKey: key.current,
                      method,
                      amount,
                      branchId: me?.activeBranchId,
                    });
                    key.current = newKey();
                    setAmount(null);
                  }, c.repaid)
                }
              >
                {c.repay}
              </Button>
            </div>
          </div>
        )}
        {method === 'CASH' && account.balance > 0 && (
          <p className="muted small">{c.shiftNeeded}</p>
        )}
        <FormError error={error} />
        {can(me, 'customers.manage') && (
          <div className="toolbar">
            {account.isOpen ? (
              <Button
                disabled={busy || account.balance > 0}
                title={c.closeHint}
                onClick={() =>
                  void run(
                    () => post(`/credit-accounts/${id}/close`),
                    c.closedOk,
                  )
                }
              >
                {c.close}
              </Button>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => post(`/credit-accounts/${id}/reopen`),
                    t.common.saved,
                  )
                }
              >
                {c.reopen}
              </Button>
            )}
            {account.isOpen && account.balance > 0 && (
              <span className="muted small">{c.closeHint}</span>
            )}
          </div>
        )}
      </section>
      <section className="card stack">
        <h2 className="section-title">{c.history}</h2>
        {account.entries.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {account.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDateTime(entry.createdAt)}</td>
                    <td>
                      {c.entryTypes[entry.type] ?? entry.type}
                      {entry.orderId &&
                        numberOf(entry.orderId) !== undefined && (
                          <span className="muted">
                            {' '}
                            ·{' '}
                            {c.order.replace(
                              '{n}',
                              String(numberOf(entry.orderId)),
                            )}
                          </span>
                        )}
                      {entry.method && (
                        <span className="muted">
                          {' '}
                          ·{' '}
                          {t.payment.methods[
                            entry.method as (typeof METHODS)[number]
                          ] ?? entry.method}
                        </span>
                      )}
                    </td>
                    <td className="right">
                      {entry.amount > 0 ? '+' : '−'}
                      {formatMoney(Math.abs(entry.amount))}
                    </td>
                    <td className="right muted">
                      {formatMoney(entry.balanceAfter)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
