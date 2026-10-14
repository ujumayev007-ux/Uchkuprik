import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Button,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  Badge,
  Checkbox,
  PageHeader,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, del, post, uploadEvidence } from '../lib/api';
import { formatMoney } from '../lib/format';

type Pnl = {
  orders: number;
  revenue: number;
  discounts: number;
  cogs: number;
  grossProfit: number;
  expenses: { category: string; amount: number }[];
  expenseTotal: number;
  payroll: number;
  netProfit: number;
};

function useRange() {
  const now = new Date();
  const [from, setFrom] = useState(
    new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
      .toISOString()
      .slice(0, 10),
  );
  const [to, setTo] = useState(now.toISOString().slice(0, 10));
  const picker = (
    <div className="toolbar">
      <TextField
        label={t.reports.from}
        type="date"
        value={from}
        max={to}
        onChange={(e) => setFrom(e.target.value)}
      />
      <TextField
        label={t.reports.to}
        type="date"
        value={to}
        min={from}
        onChange={(e) => setTo(e.target.value)}
      />
    </div>
  );
  return { from, to, picker };
}

function PnlTab() {
  const { from, to, picker } = useRange();
  const pnl = useQuery({
    queryKey: ['finance', 'pnl', from, to],
    queryFn: () => api<Pnl>(`/reports/pnl?from=${from}&to=${to}`),
  });
  const kitchen = useQuery({
    queryKey: ['finance', 'kitchen', from, to],
    queryFn: () =>
      api<{
        orders: number;
        averageMinutes: number | null;
        lateOrders: number;
        onTimePercent: number | null;
      }>(`/reports/kitchen?from=${from}&to=${to}`),
  });
  return (
    <div className="stack">
      {picker}
      {pnl.isPending ? (
        <LoadingState />
      ) : pnl.error ? (
        <ErrorState error={pnl.error} />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span>{t.finance.revenue}</span>
              <strong>{formatMoney(pnl.data.revenue)}</strong>
              <small className="muted">
                {t.reports.orders}: {pnl.data.orders}
              </small>
            </div>
            <div className="stat">
              <span>{t.finance.grossProfit}</span>
              <strong>{formatMoney(pnl.data.grossProfit)}</strong>
              <small className="muted">
                {t.finance.cogs}: {formatMoney(pnl.data.cogs)}
              </small>
            </div>
            <div className={`stat ${pnl.data.netProfit >= 0 ? 'accent' : ''}`}>
              <span>{t.finance.netProfit}</span>
              <strong className={pnl.data.netProfit < 0 ? 'danger-text' : ''}>
                {formatMoney(pnl.data.netProfit)}
              </strong>
            </div>
          </div>
          <section className="card">
            <dl className="totals">
              <dt>{t.finance.revenue}</dt>
              <dd>{formatMoney(pnl.data.revenue)}</dd>
              <dt>{t.finance.cogs}</dt>
              <dd>−{formatMoney(pnl.data.cogs)}</dd>
              <dt className="strong">{t.finance.grossProfit}</dt>
              <dd className="strong">{formatMoney(pnl.data.grossProfit)}</dd>
              {pnl.data.expenses.map((row) => (
                <div key={row.category} className="totals-row">
                  <dt>
                    {t.finance.expenses}: {row.category}
                  </dt>
                  <dd>−{formatMoney(row.amount)}</dd>
                </div>
              ))}
              <dt>{t.finance.payroll}</dt>
              <dd>−{formatMoney(pnl.data.payroll)}</dd>
              <dt className="strong">{t.finance.netProfit}</dt>
              <dd className="strong">{formatMoney(pnl.data.netProfit)}</dd>
            </dl>
            <div className="form-actions">
              <a
                className="btn btn-secondary btn-sm"
                href={`/api/reports/pnl.csv?from=${from}&to=${to}`}
              >
                {t.finance.download}
              </a>
              <a
                className="btn btn-secondary btn-sm"
                href={`/api/reports/sales.csv?from=${from}&to=${to}`}
              >
                {t.reports.sales} · CSV
              </a>
            </div>
          </section>
        </>
      )}
      {kitchen.data && (
        <section className="card">
          <h2>{t.finance.kitchenPerformance}</h2>
          <p>
            {t.finance.avgPrep}:{' '}
            <strong>{kitchen.data.averageMinutes ?? '—'}</strong> ·{' '}
            {t.finance.onTime}:{' '}
            <strong>
              {kitchen.data.onTimePercent === null
                ? '—'
                : `${kitchen.data.onTimePercent}%`}
            </strong>{' '}
            ({kitchen.data.orders})
          </p>
        </section>
      )}
    </div>
  );
}

function ExpensesTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const { from, to, picker } = useRange();
  const expenses = useQuery({
    queryKey: ['finance', 'expenses', from, to],
    queryFn: () =>
      api<{
        expenses: {
          id: string;
          category: string;
          amount: number;
          date: string;
          note: string | null;
          recipient?: string | null;
          attachmentId?: string | null;
          fromCash?: boolean;
          approvalStatus?: string;
        }[];
      }>(`/expenses?from=${from}&to=${to}`).then((d) => d.expenses),
  });
  const [form, setForm] = useState({
    category: '',
    amount: null as number | null,
    date: new Date().toISOString().slice(0, 10),
    note: '',
    recipient: '',
    fromCash: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const manage = can(me, 'finance.manage');
  const limit = useQuery({
    queryKey: ['finance', 'settings'],
    queryFn: () =>
      api<{ expenseApprovalLimit: number | null }>('/finance/settings'),
  });
  return (
    <div className="stack">
      {manage && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              const attachmentId = file
                ? await uploadEvidence(file, '/api/finance/attachments')
                : null;
              const created = await post<{ approvalStatus: string }>(
                '/expenses',
                {
                  ...form,
                  amount: form.amount ?? 0,
                  note: form.note || null,
                  recipient: form.recipient || null,
                  attachmentId,
                },
              );
              if (created.approvalStatus === 'PENDING')
                toast(t.expenseExtra.sentForApproval);
              setForm({
                ...form,
                category: '',
                amount: null,
                note: '',
                recipient: '',
              });
              setFile(null);
              await client.invalidateQueries({ queryKey: ['finance'] });
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <TextField
            label={t.finance.category}
            hint={t.finance.categoryHint}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            minLength={2}
            required
          />
          <MoneyField
            label={`${t.payment.amount} (${t.menu.sum})`}
            value={form.amount}
            onChange={(amount) => setForm({ ...form, amount })}
            required
          />
          <TextField
            label={t.hr.date}
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
          <TextField
            label={t.expenseExtra.recipient}
            value={form.recipient}
            onChange={(e) => setForm({ ...form, recipient: e.target.value })}
          />
          <TextField
            label={t.expenseExtra.note}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <label className="field">
            <span className="field-label">{t.expenseExtra.attachment}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <Checkbox
            label={t.expenseExtra.fromCash}
            checked={form.fromCash}
            onChange={(fromCash) => setForm({ ...form, fromCash })}
          />
          <Button type="submit" variant="primary">
            + {t.finance.addExpense}
          </Button>
        </form>
      )}
      <FormError error={error} />
      {manage && limit.data && (
        <MoneyField
          label={t.expenseExtra.limit}
          hint={t.expenseExtra.limitHint}
          value={limit.data.expenseApprovalLimit}
          onChange={(value) =>
            void api('/finance/settings', {
              method: 'PUT',
              body: { expenseApprovalLimit: value },
            }).then(() =>
              client.invalidateQueries({ queryKey: ['finance', 'settings'] }),
            )
          }
        />
      )}
      {picker}
      {expenses.data && expenses.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.hr.date}</th>
                <th>{t.finance.category}</th>
                <th className="right">{t.payment.amount}</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {expenses.data.map((expense) => (
                <tr key={expense.id}>
                  <td>{expense.date.slice(0, 10)}</td>
                  <td>
                    {expense.category}
                    {expense.recipient && (
                      <small className="muted block">
                        → {expense.recipient}
                      </small>
                    )}
                    {expense.approvalStatus &&
                      expense.approvalStatus !== 'APPROVED' && (
                        <Badge
                          tone={
                            expense.approvalStatus === 'PENDING'
                              ? 'warning'
                              : 'danger'
                          }
                        >
                          {t.expenseExtra.statuses[expense.approvalStatus]}
                        </Badge>
                      )}
                    {expense.fromCash && (
                      <small className="muted block">
                        💵 {t.expenseExtra.cash}
                      </small>
                    )}
                    {expense.attachmentId && (
                      <a
                        className="text-link block"
                        href={`/api/finance/attachments/${expense.attachmentId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        📎 {t.expenseExtra.open}
                      </a>
                    )}
                  </td>
                  <td className="right nowrap">
                    {formatMoney(expense.amount)}
                  </td>
                  {manage && (
                    <td className="right">
                      <button
                        className="text-link"
                        onClick={async () => {
                          try {
                            await del(`/expenses/${expense.id}`);
                            await client.invalidateQueries({
                              queryKey: ['finance'],
                            });
                          } catch (caught) {
                            toast(
                              caught instanceof Error
                                ? caught.message
                                : t.common.errorTitle,
                              'error',
                            );
                          }
                        }}
                      >
                        {t.common.delete}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function BranchesTab() {
  const { from, to, picker } = useRange();
  const report = useQuery({
    queryKey: ['finance', 'branches', from, to],
    queryFn: () =>
      api<{
        branches: {
          branchId: string;
          name: string;
          orders: number;
          sales: number;
          averageCheck: number;
          grossProfit?: number;
          netProfit?: number;
        }[];
      }>(`/reports/branches?from=${from}&to=${to}`).then((d) => d.branches),
  });
  return (
    <div className="stack">
      {picker}
      {report.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.nav.branch}</th>
                <th className="right">{t.reports.orders}</th>
                <th className="right">{t.reports.sales}</th>
                <th className="right">{t.reports.averageCheck}</th>
                <th className="right">{t.finance.grossProfit}</th>
                <th className="right">{t.finance.netProfit}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.map((row) => (
                <tr key={row.branchId}>
                  <td>{row.name}</td>
                  <td className="right">{row.orders}</td>
                  <td className="right nowrap">{formatMoney(row.sales)}</td>
                  <td className="right nowrap">
                    {formatMoney(row.averageCheck)}
                  </td>
                  <td className="right nowrap">
                    {row.grossProfit === undefined
                      ? '—'
                      : formatMoney(row.grossProfit)}
                  </td>
                  <td className="right nowrap">
                    {row.netProfit === undefined
                      ? '—'
                      : formatMoney(row.netProfit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClosingTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const closed = useQuery({
    queryKey: ['finance', 'closed'],
    queryFn: () =>
      api<{ periods: { month: string; closedAt: string }[] }>(
        '/finance/closed-periods',
      ).then((d) => d.periods),
  });
  const last = new Date();
  last.setMonth(last.getMonth() - 1);
  const [month, setMonth] = useState(last.toISOString().slice(0, 7));
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="stack narrow">
      <p className="notice">{t.finance.closeHint}</p>
      {can(me, 'finance.manage') && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await post('/finance/close', { month });
              await client.invalidateQueries({ queryKey: ['finance'] });
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <TextField
            label={t.finance.month}
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
          <Button type="submit" variant="danger">
            {t.finance.closeMonth}
          </Button>
        </form>
      )}
      <FormError error={error} />
      <h2 className="section-title">{t.finance.closedMonths}</h2>
      {closed.data && closed.data.length > 0 ? (
        <ul className="plain-list">
          {closed.data.map((period) => (
            <li key={period.month}>{period.month}</li>
          ))}
        </ul>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

type Tab = 'pnl' | 'expenses' | 'branches' | 'closing';

export function FinancePage() {
  const [tab, setTab] = useState<Tab>('pnl');
  return (
    <>
      <PageHeader title={t.finance.title} subtitle={t.finance.subtitle} />
      <div className="tabs" role="tablist">
        {(['pnl', 'expenses', 'branches', 'closing'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.finance.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'pnl' && <PnlTab />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'branches' && <BranchesTab />}
      {tab === 'closing' && <ClosingTab />}
    </>
  );
}
