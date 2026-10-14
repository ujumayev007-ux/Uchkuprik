import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
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
import { LoyaltyCardPanel } from './LoyaltyCardPanel';
import { api, patch, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

type Customer = {
  id: string;
  phone: string;
  name: string | null;
  points: number;
  totalSpent: number;
  orderCount: number;
  lastOrderAt: string | null;
  marketingConsent: boolean;
  tier: string;
  // Restaurant-defined level name, when loyalty tiers are configured.
  level?: string | null;
  cardCode?: string | null;
  referredById?: string | null;
};

const tierTone = {
  STANDARD: 'neutral',
  SILVER: 'neutral',
  GOLD: 'warning',
  PLATINUM: 'accent',
} as const;

function CustomerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const detail = useQuery({
    queryKey: ['customers', id],
    queryFn: () =>
      api<{
        customer: Customer & { birthday: string | null; notes: string | null };
        orders: {
          id: string;
          number: number;
          status: string;
          total: number;
          createdAt: string;
        }[];
        loyalty: {
          id: string;
          type: string;
          points: number;
          balanceAfter: number;
          reason: string | null;
          createdAt: string;
        }[];
      }>(`/customers/${id}`),
  });
  const [form, setForm] = useState<{
    name: string;
    consent: boolean;
    notes: string;
  } | null>(null);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const manage = can(me, 'customers.manage');
  if (detail.isPending)
    return (
      <Dialog open title={t.crm.title} onClose={onClose}>
        <LoadingState />
      </Dialog>
    );
  if (detail.error)
    return (
      <Dialog open title={t.crm.title} onClose={onClose}>
        <ErrorState error={detail.error} />
      </Dialog>
    );
  const { customer, orders, loyalty } = detail.data;
  const values = form ?? {
    name: customer.name ?? '',
    consent: customer.marketingConsent,
    notes: customer.notes ?? '',
  };
  const refresh = () => client.invalidateQueries({ queryKey: ['customers'] });
  return (
    <Dialog
      open
      wide
      title={customer.name ?? customer.phone}
      description={customer.phone}
      onClose={onClose}
    >
      <div className="stack">
        <div className="stat-grid">
          <div className="stat">
            <span>{t.crm.points}</span>
            <strong>{customer.points}</strong>
          </div>
          <div className="stat">
            <span>{t.crm.totalSpent}</span>
            <strong>{formatMoney(customer.totalSpent)}</strong>
          </div>
          <div className="stat">
            <span>{t.crm.tier}</span>
            <strong>{customer.level ?? t.crm.tiers[customer.tier]}</strong>
          </div>
        </div>
        <LoyaltyCardPanel
          customerId={id}
          name={customer.name ?? customer.phone}
          cardCode={customer.cardCode ?? null}
          canReferral={
            manage && customer.orderCount === 0 && !customer.referredById
          }
          onChange={() => void refresh()}
        />
        {manage && (
          <form
            className="stack card"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              try {
                await patch(`/customers/${id}`, {
                  name: values.name || null,
                  marketingConsent: values.consent,
                  notes: values.notes || null,
                });
                toast(t.common.saved);
                await refresh();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            <TextField
              label={t.common.name}
              value={values.name}
              onChange={(e) => setForm({ ...values, name: e.target.value })}
            />
            <Checkbox
              label={t.crm.consent}
              description={t.crm.consentHint}
              checked={values.consent}
              onChange={(consent) => setForm({ ...values, consent })}
            />
            <TextField
              label={t.crm.notes}
              value={values.notes}
              onChange={(e) => setForm({ ...values, notes: e.target.value })}
            />
            <FormError error={error} />
            <div className="form-actions">
              <Button type="submit" variant="primary">
                {t.common.save}
              </Button>
            </div>
          </form>
        )}
        {manage && (
          <form
            className="inline-form"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await post(`/customers/${id}/points`, {
                  points: Number(adjust.points),
                  reason: adjust.reason,
                });
                setAdjust({ points: '', reason: '' });
                toast(t.common.saved);
                await refresh();
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
            <TextField
              label={t.crm.pointsChange}
              inputMode="numeric"
              value={adjust.points}
              onChange={(e) =>
                setAdjust({
                  ...adjust,
                  points: e.target.value.replace(/[^\d-]/g, ''),
                })
              }
              required
            />
            <TextField
              label={t.inventory.reason}
              value={adjust.reason}
              onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}
              minLength={3}
              required
            />
            <Button type="submit">{t.crm.adjustPoints}</Button>
          </form>
        )}
        <h3 className="section-title">{t.crm.history}</h3>
        <ul className="plain-list">
          {orders.map((order) => (
            <li key={order.id} className="track-line">
              <span>
                {t.orders.number}
                {order.number} · {formatDateTime(order.createdAt)} ·{' '}
                {t.orders.statuses[order.status as 'DRAFT']}
              </span>
              <strong>{formatMoney(order.total)}</strong>
            </li>
          ))}
        </ul>
        <h3 className="section-title">{t.crm.ledger}</h3>
        <ul className="plain-list small">
          {loyalty.map((entry) => (
            <li key={entry.id} className="track-line">
              <span>
                {formatDateTime(entry.createdAt)} ·{' '}
                {t.crm.loyaltyTypes[entry.type]}{' '}
                {entry.reason && `· ${entry.reason}`}
              </span>
              <span className={entry.points < 0 ? 'danger-text' : ''}>
                {entry.points > 0 ? '+' : ''}
                {entry.points} → {entry.balanceAfter}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

function CustomersTab() {
  const { data: me } = useMe();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const customers = useQuery({
    queryKey: ['customers', 'list', q],
    queryFn: () =>
      api<{ customers: Customer[] }>(
        `/customers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      ).then((data) => data.customers),
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder={t.crm.searchHint}
          aria-label={t.crm.searchHint}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {can(me, 'customers.manage') && (
          <a
            className="btn btn-secondary btn-md"
            href="/api/customers-export/marketing"
          >
            {t.crm.exportMarketing}
          </a>
        )}
      </div>
      {customers.isPending ? (
        <LoadingState />
      ) : customers.error ? (
        <ErrorState error={customers.error} />
      ) : customers.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{t.crm.tier}</th>
                <th className="right">{t.crm.points}</th>
                <th className="right">{t.crm.orderCount}</th>
                <th className="right">{t.crm.totalSpent}</th>
                <th>{t.crm.lastOrder}</th>
              </tr>
            </thead>
            <tbody>
              {customers.data.map((customer) => (
                <tr
                  key={customer.id}
                  className="clickable"
                  onClick={() => setSelected(customer.id)}
                >
                  <td>
                    <button
                      className="text-link inline"
                      onClick={() => setSelected(customer.id)}
                    >
                      {customer.name ?? '—'}
                    </button>
                    <small className="muted block">{customer.phone}</small>
                  </td>
                  <td>
                    <Badge
                      tone={
                        tierTone[customer.tier as keyof typeof tierTone] ??
                        'neutral'
                      }
                    >
                      {customer.level ?? t.crm.tiers[customer.tier]}
                    </Badge>
                    {customer.marketingConsent && (
                      <Badge tone="success">✓</Badge>
                    )}
                  </td>
                  <td className="right">{customer.points}</td>
                  <td className="right">{customer.orderCount}</td>
                  <td className="right nowrap">
                    {formatMoney(customer.totalSpent)}
                  </td>
                  <td>{formatDateTime(customer.lastOrderAt, '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <CustomerDetail id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

type Coupon = {
  id: string;
  code: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  minOrder: number;
  maxUses: number | null;
  usedCount: number;
  validTo: string | null;
  isActive: boolean;
};

function CouponsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const coupons = useQuery({
    queryKey: ['coupons'],
    queryFn: () =>
      api<{ coupons: Coupon[] }>('/coupons').then((data) => data.coupons),
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    code: '',
    kind: 'PERCENT' as Coupon['kind'],
    value: '10',
    minOrder: null as number | null,
    maxUses: '',
    validTo: '',
  });
  const [error, setError] = useState<unknown>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['coupons'] });
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setCreating(true)}>
          + {t.crm.newCoupon}
        </Button>
      </div>
      {coupons.data && coupons.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.crm.couponCode}</th>
                <th>{t.crm.couponValue}</th>
                <th className="right">{t.crm.minOrder}</th>
                <th className="right">{t.crm.used}</th>
                <th>{t.crm.validTo}</th>
                <th>{t.common.status}</th>
              </tr>
            </thead>
            <tbody>
              {coupons.data.map((coupon) => (
                <tr key={coupon.id}>
                  <td>
                    <code>{coupon.code}</code>
                  </td>
                  <td>
                    {coupon.kind === 'PERCENT'
                      ? `${coupon.value / 100}%`
                      : formatMoney(coupon.value)}
                  </td>
                  <td className="right">{formatMoney(coupon.minOrder)}</td>
                  <td className="right">
                    {coupon.usedCount}
                    {coupon.maxUses ? ` / ${coupon.maxUses}` : ''}
                  </td>
                  <td>
                    {coupon.validTo ? formatDateTime(coupon.validTo) : '—'}
                  </td>
                  <td>
                    <Checkbox
                      label={
                        coupon.isActive ? t.common.active : t.common.inactive
                      }
                      checked={coupon.isActive}
                      onChange={async (isActive) => {
                        await patch(`/coupons/${coupon.id}`, { isActive });
                        await refresh();
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
      <Dialog
        open={creating}
        title={t.crm.newCoupon}
        onClose={() => setCreating(false)}
      >
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await post('/coupons', {
                code: form.code,
                kind: form.kind,
                value:
                  form.kind === 'PERCENT'
                    ? Math.round(Number(form.value) * 100)
                    : Number(form.value.replace(/\D/g, '')),
                minOrder: form.minOrder ?? 0,
                maxUses: form.maxUses ? Number(form.maxUses) : null,
                validTo: form.validTo
                  ? new Date(`${form.validTo}T23:59:59`).toISOString()
                  : null,
              });
              setCreating(false);
              toast(t.common.saved);
              await refresh();
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <div className="form-grid">
            <TextField
              label={t.crm.couponCode}
              value={form.code}
              onChange={(e) =>
                setForm({ ...form, code: e.target.value.toUpperCase() })
              }
              pattern="[A-Za-z0-9_\-]{3,30}"
              required
            />
            <SelectField
              label={t.crm.couponKind}
              value={form.kind}
              onChange={(e) =>
                setForm({ ...form, kind: e.target.value as Coupon['kind'] })
              }
            >
              <option value="PERCENT">{t.crm.couponKinds.PERCENT}</option>
              <option value="FIXED">{t.crm.couponKinds.FIXED}</option>
            </SelectField>
            <TextField
              label={`${t.crm.couponValue} (${form.kind === 'PERCENT' ? '%' : t.menu.sum})`}
              inputMode="decimal"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              required
            />
            <MoneyField
              label={`${t.crm.minOrder} (${t.menu.sum})`}
              value={form.minOrder}
              onChange={(minOrder) => setForm({ ...form, minOrder })}
            />
            <TextField
              label={`${t.crm.maxUses} (${t.common.optional})`}
              inputMode="numeric"
              value={form.maxUses}
              onChange={(e) =>
                setForm({ ...form, maxUses: e.target.value.replace(/\D/g, '') })
              }
            />
            <TextField
              label={`${t.crm.validTo} (${t.common.optional})`}
              type="date"
              value={form.validTo}
              onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            />
          </div>
          <FormError error={error} />
          <Button type="submit" variant="primary">
            {t.common.create}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

type Feedback = {
  id: string;
  rating: number;
  comment: string | null;
  status: 'NEW' | 'RESOLVED';
  resolution: string | null;
  createdAt: string;
  order: {
    number: number;
    customerName: string | null;
    customerPhone: string | null;
  } | null;
};

function FeedbackTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const feedback = useQuery({
    queryKey: ['feedback'],
    queryFn: () =>
      api<{
        stats: {
          count: number;
          averageRating: number | null;
          csat: number | null;
          openComplaints: number;
        };
        feedback: Feedback[];
      }>('/feedback'),
  });
  if (feedback.isPending) return <LoadingState />;
  if (feedback.error) return <ErrorState error={feedback.error} />;
  const { stats, feedback: rows } = feedback.data;
  return (
    <div className="stack">
      <div className="stat-grid">
        <div className="stat">
          <span>{t.crm.csat}</span>
          <strong>{stats.csat === null ? '—' : `${stats.csat}%`}</strong>
        </div>
        <div className="stat">
          <span>{t.crm.average}</span>
          <strong>{stats.averageRating ?? '—'}</strong>
          <small className="muted">{stats.count}</small>
        </div>
        <div className="stat">
          <span>{t.crm.complaints}</span>
          <strong className={stats.openComplaints ? 'danger-text' : ''}>
            {stats.openComplaints}
          </strong>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="card-list">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`card feedback-card ${row.rating <= 2 && row.status === 'NEW' ? 'complaint' : ''}`}
            >
              <div className="track-line">
                <strong aria-label={`${t.crm.rating}: ${row.rating}`}>
                  {'★'.repeat(row.rating)}
                  {'☆'.repeat(5 - row.rating)}
                </strong>
                <span className="muted small">
                  {row.order ? `${t.orders.number}${row.order.number} · ` : ''}
                  {formatDateTime(row.createdAt)}
                </span>
              </div>
              {row.comment && <p>{row.comment}</p>}
              {row.status === 'RESOLVED' ? (
                <Badge tone="success">
                  {t.crm.resolved}: {row.resolution}
                </Badge>
              ) : (
                can(me, 'customers.manage') && (
                  <Button
                    size="sm"
                    onClick={async () => {
                      const resolution = window.prompt(t.crm.resolution) ?? '';
                      if (resolution.trim().length < 3) return;
                      try {
                        await post(`/feedback/${row.id}/resolve`, {
                          resolution,
                        });
                        await client.invalidateQueries({
                          queryKey: ['feedback'],
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
                    {t.crm.resolve}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Tab = 'customers' | 'coupons' | 'feedback';

export function CustomersPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>('customers');
  const tabs: Tab[] = can(me, 'customers.manage')
    ? ['customers', 'coupons', 'feedback']
    : ['customers', 'feedback'];
  return (
    <>
      <PageHeader title={t.crm.title} subtitle={t.crm.subtitle} />
      <div className="tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.crm.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'customers' && <CustomersTab />}
      {tab === 'coupons' && <CouponsTab />}
      {tab === 'feedback' && <FeedbackTab />}
    </>
  );
}
