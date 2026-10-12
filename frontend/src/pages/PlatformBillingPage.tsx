import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import {
  featureName,
  statusTone,
  type Invoice,
  type Plan,
} from './SubscriptionPage';

type Analytics = {
  mrr: number;
  arr: number;
  arpa: number;
  payingTenants: number;
  openAmount: number;
  overdueAmount: number;
  collected30d: number;
  churnRate30d: number;
};

type SubscriptionRow = {
  tenantId: string;
  tenantName: string;
  slug: string;
  tenantStatus: string;
  status: keyof typeof t.billing.status | null;
  planCode: string | null;
  billingCycle: 'MONTHLY' | 'YEARLY' | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  openBalance: number;
};

type PlatformInvoice = Invoice & {
  tenantName: string;
  slug: string;
  overdue: boolean;
};

type PlatformPlan = Plan & { sortOrder: number; subscriptionCount: number };

function Stats() {
  const analytics = useQuery({
    queryKey: ['platform-analytics'],
    queryFn: () => api<Analytics>('/platform/analytics'),
  });
  if (!analytics.data) return null;
  const a = analytics.data;
  const items: [string, string][] = [
    [t.platformBilling.mrr, formatMoney(a.mrr)],
    [t.platformBilling.arr, formatMoney(a.arr)],
    [t.platformBilling.arpa, formatMoney(a.arpa)],
    [t.platformBilling.paying, String(a.payingTenants)],
    [t.platformBilling.open, formatMoney(a.openAmount)],
    [t.platformBilling.overdue, formatMoney(a.overdueAmount)],
    [t.platformBilling.collected, formatMoney(a.collected30d)],
    [t.platformBilling.churn, `${a.churnRate30d}%`],
  ];
  return (
    <div className="stat-grid">
      {items.map(([label, value]) => (
        <div key={label} className="stat">
          <small className="muted">{label}</small>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function PlanDialog({
  plan,
  features,
  onClose,
}: {
  plan: PlatformPlan | 'new';
  features: string[];
  onClose: (saved: boolean) => void;
}) {
  const initial =
    plan === 'new'
      ? {
          code: '',
          name: '',
          monthlyPrice: 0,
          yearlyPrice: 0,
          maxBranches: null as number | null,
          maxUsers: null as number | null,
          maxDevices: null as number | null,
          features: [] as string[],
          trialDays: 14,
          isActive: true,
          sortOrder: 10,
        }
      : plan;
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const limit = (value: string) => (value === '' ? null : Number(value));
  return (
    <Dialog
      open
      wide
      title={
        plan === 'new' ? t.platformBilling.addPlan : t.platformBilling.editPlan
      }
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const body = {
                  code: form.code,
                  name: form.name,
                  monthlyPrice: form.monthlyPrice,
                  yearlyPrice: form.yearlyPrice,
                  maxBranches: form.maxBranches,
                  maxUsers: form.maxUsers,
                  maxDevices: form.maxDevices,
                  features: form.features,
                  trialDays: form.trialDays,
                  isActive: form.isActive,
                  sortOrder: form.sortOrder,
                };
                if (plan === 'new') await post('/platform/plans', body);
                else
                  await api(`/platform/plans/${plan.id}`, {
                    method: 'PUT',
                    body,
                  });
                onClose(true);
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <TextField
            label={t.common.code}
            value={form.code}
            onChange={(event) =>
              setForm({ ...form, code: event.target.value.toUpperCase() })
            }
            pattern="[A-Z0-9_]{2,20}"
            required
          />
          <TextField
            label={t.common.name}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
          <MoneyField
            label={t.platformBilling.monthlyPrice}
            value={form.monthlyPrice}
            onChange={(value) => setForm({ ...form, monthlyPrice: value ?? 0 })}
          />
          <MoneyField
            label={t.platformBilling.yearlyPrice}
            value={form.yearlyPrice}
            onChange={(value) => setForm({ ...form, yearlyPrice: value ?? 0 })}
          />
          {(
            [
              ['maxBranches', t.platformBilling.maxBranches],
              ['maxUsers', t.platformBilling.maxUsers],
              ['maxDevices', t.platformBilling.maxDevices],
            ] as const
          ).map(([key, label]) => (
            <TextField
              key={key}
              label={label}
              hint={t.platformBilling.limitHint}
              inputMode="numeric"
              value={form[key] ?? ''}
              onChange={(event) =>
                setForm({
                  ...form,
                  [key]: limit(event.target.value.replace(/\D/g, '')),
                })
              }
            />
          ))}
          <TextField
            label={t.platformBilling.trialDays}
            inputMode="numeric"
            value={form.trialDays}
            onChange={(event) =>
              setForm({
                ...form,
                trialDays: Number(event.target.value.replace(/\D/g, '') || 0),
              })
            }
          />
        </div>
        <fieldset>
          <legend>{t.billing.features}</legend>
          <div className="check-grid">
            {features.map((feature) => (
              <Checkbox
                key={feature}
                label={featureName(feature)}
                checked={form.features.includes(feature)}
                onChange={(checked) =>
                  setForm({
                    ...form,
                    features: checked
                      ? [...form.features, feature]
                      : form.features.filter((key) => key !== feature),
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        <Checkbox
          label={t.common.active}
          checked={form.isActive}
          onChange={(isActive) => setForm({ ...form, isActive })}
        />
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function ChangePlanDialog({
  row,
  plans,
  onClose,
}: {
  row: SubscriptionRow;
  plans: PlatformPlan[];
  onClose: (saved: boolean) => void;
}) {
  const [planCode, setPlanCode] = useState(
    row.planCode ?? plans[0]?.code ?? '',
  );
  const [cycle, setCycle] = useState(row.billingCycle ?? 'MONTHLY');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      title={`${t.platformBilling.changePlan}: ${row.tenantName}`}
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(`/platform/tenants/${row.tenantId}/subscription`, {
                  planCode,
                  billingCycle: cycle,
                });
                onClose(true);
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="stack">
        <SelectField
          label={t.billing.plan}
          value={planCode}
          onChange={(event) => setPlanCode(event.target.value)}
        >
          {plans.map((plan) => (
            <option key={plan.code} value={plan.code}>
              {plan.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t.billing.cycle.MONTHLY + ' / ' + t.billing.cycle.YEARLY}
          value={cycle}
          onChange={(event) =>
            setCycle(event.target.value as 'MONTHLY' | 'YEARLY')
          }
        >
          <option value="MONTHLY">{t.billing.cycle.MONTHLY}</option>
          <option value="YEARLY">{t.billing.cycle.YEARLY}</option>
        </SelectField>
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function PayDialog({
  invoice,
  onClose,
}: {
  invoice: PlatformInvoice;
  onClose: (saved: boolean) => void;
}) {
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      title={`${t.platformBilling.markPaid}: ${invoice.number}`}
      description={`${invoice.tenantName} · ${formatMoney(invoice.amount)}`}
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={reference.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(`/platform/invoices/${invoice.id}/pay`, {
                  reference,
                });
                onClose(true);
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.platformBilling.markPaid}
          </Button>
        </>
      }
    >
      <TextField
        label={t.platformBilling.reference}
        value={reference}
        maxLength={100}
        onChange={(event) => setReference(event.target.value)}
      />
      <FormError error={error} />
    </Dialog>
  );
}

export function PlatformBillingPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [editing, setEditing] = useState<PlatformPlan | 'new' | null>(null);
  const [changing, setChanging] = useState<SubscriptionRow | null>(null);
  const [paying, setPaying] = useState<PlatformInvoice | null>(null);
  const [running, setRunning] = useState(false);
  const plans = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () =>
      api<{ plans: PlatformPlan[]; features: string[] }>('/platform/plans'),
  });
  const subscriptions = useQuery({
    queryKey: ['platform-subscriptions'],
    queryFn: () =>
      api<{ subscriptions: SubscriptionRow[] }>('/platform/subscriptions').then(
        (data) => data.subscriptions,
      ),
  });
  const invoices = useQuery({
    queryKey: ['platform-invoices'],
    queryFn: () =>
      api<{ invoices: PlatformInvoice[] }>('/platform/invoices').then(
        (data) => data.invoices,
      ),
  });
  const refresh = () =>
    Promise.all(
      [
        'platform-plans',
        'platform-subscriptions',
        'platform-invoices',
        'platform-analytics',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
  const done = (saved: boolean) => {
    setEditing(null);
    setChanging(null);
    setPaying(null);
    if (saved) {
      toast(t.common.saved);
      void refresh();
    }
  };

  const error = plans.error ?? subscriptions.error ?? invoices.error;
  if (error) return <ErrorState error={error} onRetry={() => void refresh()} />;
  if (!plans.data || !subscriptions.data || !invoices.data)
    return <LoadingState />;

  return (
    <div className="stack">
      <PageHeader
        title={t.platformBilling.title}
        subtitle={t.platformBilling.subtitle}
        actions={
          <Button
            busy={running}
            onClick={async () => {
              setRunning(true);
              try {
                const result = await post<{ processed: number }>(
                  '/platform/billing/run',
                );
                toast(
                  t.platformBilling.processed.replace(
                    '{count}',
                    String(result.processed),
                  ),
                );
                await refresh();
              } catch (caught) {
                toast(errorMessage(caught), 'error');
              } finally {
                setRunning(false);
              }
            }}
          >
            {t.platformBilling.runBilling}
          </Button>
        }
      />
      <Stats />

      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">{t.platformBilling.plansTitle}</h2>
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            + {t.platformBilling.addPlan}
          </Button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.billing.plan}</th>
                <th className="right">{t.platformBilling.monthlyPrice}</th>
                <th className="right">{t.platformBilling.yearlyPrice}</th>
                <th>{t.billing.usage}</th>
                <th>{t.billing.features}</th>
                <th className="right">{t.platformBilling.subscriptions}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {plans.data.plans.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <strong>{plan.name}</strong>{' '}
                    <span className="muted small">{plan.code}</span>
                    {!plan.isActive && (
                      <>
                        {' '}
                        <Badge>{t.common.inactive}</Badge>
                      </>
                    )}
                  </td>
                  <td className="right nowrap">
                    {formatMoney(plan.monthlyPrice)}
                  </td>
                  <td className="right nowrap">
                    {formatMoney(plan.yearlyPrice)}
                  </td>
                  <td className="nowrap small">
                    {plan.maxBranches ?? '∞'} / {plan.maxUsers ?? '∞'} /{' '}
                    {plan.maxDevices ?? '∞'}
                  </td>
                  <td className="small">
                    {plan.features.map(featureName).join(', ') || '—'}
                  </td>
                  <td className="right">{plan.subscriptionCount}</td>
                  <td className="right">
                    <Button size="sm" onClick={() => setEditing(plan)}>
                      {t.common.edit}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack">
        <h2 className="section-title">{t.platformBilling.title}</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.platformBilling.tenant}</th>
                <th>{t.billing.plan}</th>
                <th>{t.common.status}</th>
                <th>{t.billing.periodEnds}</th>
                <th className="right">{t.platformBilling.balance}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.data.map((row) => (
                <tr key={row.tenantId}>
                  <td>
                    <strong>{row.tenantName}</strong>{' '}
                    <span className="muted small">{row.slug}</span>
                  </td>
                  <td className="nowrap">
                    {row.planCode ?? t.platformBilling.noPlan}
                    {row.billingCycle && (
                      <span className="muted small">
                        {' '}
                        · {t.billing.cycle[row.billingCycle]}
                      </span>
                    )}
                  </td>
                  <td>
                    {row.status ? (
                      <Badge tone={statusTone(row.status)}>
                        {t.billing.status[row.status]}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="nowrap">
                    {formatDateTime(
                      row.status === 'TRIALING'
                        ? row.trialEndsAt
                        : row.currentPeriodEnd,
                    )}
                  </td>
                  <td className="right nowrap">
                    {formatMoney(row.openBalance)}
                  </td>
                  <td className="right">
                    {row.tenantStatus !== 'CLOSED' && (
                      <Button size="sm" onClick={() => setChanging(row)}>
                        {t.platformBilling.changePlan}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack">
        <h2 className="section-title">{t.billing.invoices}</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.billing.invoice}</th>
                <th>{t.platformBilling.tenant}</th>
                <th className="right">{t.billing.amount}</th>
                <th>{t.billing.dueDate}</th>
                <th>{t.common.status}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="nowrap">{invoice.number}</td>
                  <td>{invoice.tenantName}</td>
                  <td className="right nowrap">
                    {formatMoney(invoice.amount)}
                  </td>
                  <td className="nowrap">
                    {formatDateTime(invoice.dueDate).slice(0, 10)}
                  </td>
                  <td>
                    <Badge
                      tone={
                        invoice.overdue ? 'danger' : statusTone(invoice.status)
                      }
                    >
                      {t.billing.invoiceStatus[invoice.status]}
                    </Badge>
                    {invoice.reference && (
                      <span className="muted small"> {invoice.reference}</span>
                    )}
                  </td>
                  <td className="right nowrap">
                    {invoice.status === 'OPEN' && (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setPaying(invoice)}
                        >
                          {t.platformBilling.markPaid}
                        </Button>{' '}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (!(await confirm(t.platformBilling.voidConfirm)))
                              return;
                            try {
                              await post(
                                `/platform/invoices/${invoice.id}/void`,
                              );
                              toast(t.common.saved);
                              await refresh();
                            } catch (caught) {
                              toast(errorMessage(caught), 'error');
                            }
                          }}
                        >
                          {t.platformBilling.void}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <PlanDialog
          plan={editing}
          features={plans.data.features}
          onClose={done}
        />
      )}
      {changing && (
        <ChangePlanDialog
          row={changing}
          plans={plans.data.plans.filter((plan) => plan.isActive)}
          onClose={done}
        />
      )}
      {paying && <PayDialog invoice={paying} onClose={done} />}
      {confirmElement}
    </div>
  );
}
