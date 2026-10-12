import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { meKey, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

export type Plan = {
  id: string;
  code: string;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxBranches: number | null;
  maxUsers: number | null;
  maxDevices: number | null;
  features: string[];
  trialDays: number;
  isActive: boolean;
};

export type Invoice = {
  id: string;
  number: string;
  planCode: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  status: 'OPEN' | 'PAID' | 'VOID';
  dueDate: string;
  paidAt: string | null;
  reference: string | null;
};

type Billing = {
  subscription: {
    status: keyof typeof t.billing.status;
    billingCycle: 'MONTHLY' | 'YEARLY';
    trialEndsAt: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    plan: Plan;
  } | null;
  usage: { branches: number; users: number; devices: number };
  isOwner: boolean;
  plans: Plan[];
  invoices: Invoice[];
  features: string[];
};

export const statusTone = (status: string) =>
  status === 'ACTIVE' || status === 'PAID'
    ? 'success'
    : status === 'TRIALING' || status === 'OPEN'
      ? 'accent'
      : status === 'PAST_DUE'
        ? 'warning'
        : 'danger';

export const featureName = (key: string) =>
  (t.billing.featureNames as Record<string, string>)[key] ?? key;

function UsageBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number | null;
}) {
  const percent = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="usage">
      <div className="usage-head">
        <span>{label}</span>
        <strong>
          {used} / {max ?? t.billing.unlimited}
        </strong>
      </div>
      {max !== null && (
        <div
          className={`usage-bar ${percent >= 100 ? 'full' : ''}`}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={used}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

export function PlanCard({
  plan,
  cycle,
  current,
  action,
}: {
  plan: Plan;
  cycle: 'MONTHLY' | 'YEARLY';
  current?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <article className={`plan-card ${current ? 'current' : ''}`}>
      <header>
        <h3>{plan.name}</h3>
        {current && <Badge tone="accent">{t.billing.current}</Badge>}
      </header>
      <p className="plan-price">
        {formatMoney(cycle === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice)}
        <small>
          {cycle === 'YEARLY' ? t.billing.perYear : t.billing.perMonth}
        </small>
      </p>
      <ul className="plan-limits">
        <li>
          {t.billing.branches}: {plan.maxBranches ?? t.billing.unlimited}
        </li>
        <li>
          {t.billing.users}: {plan.maxUsers ?? t.billing.unlimited}
        </li>
        <li>
          {t.billing.devices}: {plan.maxDevices ?? t.billing.unlimited}
        </li>
      </ul>
      <ul className="plan-features">
        <li>✓ {t.billing.core}</li>
        {plan.features.map((feature) => (
          <li key={feature}>✓ {featureName(feature)}</li>
        ))}
      </ul>
      {action}
    </article>
  );
}

function DataSection({ slug }: { slug: string }) {
  const toast = useToast();
  const client = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    try {
      const data = await api<unknown>('/tenant/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `fastfood-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  };
  return (
    <>
      <section className="card stack">
        <h2 className="section-title">{t.billing.data}</h2>
        <p className="muted">{t.billing.exportHint}</p>
        <div>
          <Button onClick={() => void download()}>{t.billing.export}</Button>
        </div>
      </section>
      <section className="card stack danger-zone">
        <h2 className="section-title">{t.billing.danger}</h2>
        <p className="muted">{t.billing.closeHint}</p>
        <div>
          <Button variant="danger" onClick={() => setClosing(true)}>
            {t.billing.close}
          </Button>
        </div>
      </section>
      <Dialog
        open={closing}
        title={t.billing.close}
        description={t.billing.closeHint}
        onClose={() => setClosing(false)}
        footer={
          <>
            <Button onClick={() => setClosing(false)}>{t.common.cancel}</Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={confirmText !== slug}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await post('/tenant/close', { confirm: confirmText });
                  toast(t.billing.closed);
                  client.setQueryData(meKey, null);
                  client.clear();
                  window.location.assign('/kirish');
                } catch (caught) {
                  setError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t.billing.close}
            </Button>
          </>
        }
      >
        <TextField
          label={t.billing.closeConfirm.replace('{slug}', slug)}
          value={confirmText}
          autoCapitalize="none"
          onChange={(event) => setConfirmText(event.target.value.trim())}
        />
        <FormError error={error} />
      </Dialog>
    </>
  );
}

export function SubscriptionPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [cycle, setCycle] = useState<'MONTHLY' | 'YEARLY' | null>(null);
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<Billing>('/billing'),
  });
  if (billing.isPending) return <LoadingState />;
  if (billing.error)
    return (
      <ErrorState
        error={billing.error}
        onRetry={() => void billing.refetch()}
      />
    );
  const data = billing.data;
  const sub = data.subscription;
  const activeCycle = cycle ?? sub?.billingCycle ?? 'MONTHLY';
  const choose = async (plan: Plan) => {
    if (!(await confirm(t.billing.changeConfirm))) return;
    try {
      await post('/billing/plan', {
        planCode: plan.code,
        billingCycle: activeCycle,
      });
      toast(t.billing.changed);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['billing'] }),
        client.invalidateQueries({ queryKey: meKey }),
      ]);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  };
  const limits = sub?.plan;
  return (
    <div className="stack">
      <PageHeader title={t.billing.title} subtitle={t.billing.subtitle} />
      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">{t.billing.currentPlan}</h2>
          {sub && (
            <Badge tone={statusTone(sub.status)}>
              {t.billing.status[sub.status]}
            </Badge>
          )}
        </div>
        {sub ? (
          <p>
            <strong>{sub.plan.name}</strong> ·{' '}
            {t.billing.cycle[sub.billingCycle]}
            {' · '}
            {sub.status === 'TRIALING'
              ? `${t.billing.trialEnds}: ${formatDateTime(sub.trialEndsAt)}`
              : `${t.billing.periodEnds}: ${formatDateTime(sub.currentPeriodEnd)}`}
          </p>
        ) : (
          <p className="muted">{t.billing.noSubscription}</p>
        )}
        <div className="usage-grid">
          <UsageBar
            label={t.billing.branches}
            used={data.usage.branches}
            max={limits?.maxBranches ?? null}
          />
          <UsageBar
            label={t.billing.users}
            used={data.usage.users}
            max={limits?.maxUsers ?? null}
          />
          <UsageBar
            label={t.billing.devices}
            used={data.usage.devices}
            max={limits?.maxDevices ?? null}
          />
        </div>
      </section>

      <section className="stack">
        <div className="toolbar">
          <h2 className="section-title">{t.billing.plans}</h2>
          <div className="segmented" role="group" aria-label={t.billing.plan}>
            {(['MONTHLY', 'YEARLY'] as const).map((value) => (
              <button
                key={value}
                className={activeCycle === value ? 'active' : ''}
                aria-pressed={activeCycle === value}
                onClick={() => setCycle(value)}
              >
                {t.billing.cycle[value]}
              </button>
            ))}
          </div>
        </div>
        {!data.isOwner && <p className="muted">{t.billing.ownerOnly}</p>}
        <div className="plan-grid">
          {data.plans.map((plan) => {
            const current =
              sub?.plan.code === plan.code && sub.billingCycle === activeCycle;
            return (
              <PlanCard
                key={plan.id}
                plan={plan}
                cycle={activeCycle}
                current={sub?.plan.code === plan.code}
                action={
                  data.isOwner && !current ? (
                    <Button variant="primary" onClick={() => void choose(plan)}>
                      {t.billing.choose}
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </div>
      </section>

      <section className="card stack">
        <h2 className="section-title">{t.billing.invoices}</h2>
        <p className="muted small">{t.billing.payHint}</p>
        {data.invoices.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t.billing.invoice}</th>
                  <th>{t.billing.period}</th>
                  <th className="right">{t.billing.amount}</th>
                  <th>{t.billing.dueDate}</th>
                  <th>{t.common.status}</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="nowrap">{invoice.number}</td>
                    <td className="nowrap">
                      {formatDateTime(invoice.periodStart).slice(0, 10)} –{' '}
                      {formatDateTime(invoice.periodEnd).slice(0, 10)}
                    </td>
                    <td className="right nowrap">
                      {formatMoney(invoice.amount)}
                    </td>
                    <td className="nowrap">
                      {formatDateTime(invoice.dueDate).slice(0, 10)}
                    </td>
                    <td>
                      <Badge tone={statusTone(invoice.status)}>
                        {t.billing.invoiceStatus[invoice.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.isOwner && me && <DataSection slug={me.tenant.slug} />}
      {confirmElement}
    </div>
  );
}
