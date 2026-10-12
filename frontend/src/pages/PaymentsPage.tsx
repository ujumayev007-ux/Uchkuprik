import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

type Provider = {
  provider: 'PAYME' | 'CLICK';
  configured: boolean;
  merchantId: string | null;
  serviceId: string | null;
  merchantUserId: string | null;
  isActive: boolean;
  testMode: boolean;
  callbackUrls: string[];
};

function ProviderCard({ provider }: { provider: Provider }) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    merchantId: provider.merchantId ?? '',
    serviceId: provider.serviceId ?? '',
    merchantUserId: provider.merchantUserId ?? '',
    secret: '',
    isActive: provider.configured ? provider.isActive : true,
    testMode: provider.testMode,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const click = provider.provider === 'CLICK';
  return (
    <form
      className="card stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api(`/payments/providers/${provider.provider}`, {
            method: 'PUT',
            body: {
              merchantId: form.merchantId,
              serviceId: click ? form.serviceId : null,
              merchantUserId: click ? form.merchantUserId || null : null,
              ...(form.secret ? { secret: form.secret } : {}),
              isActive: form.isActive,
              testMode: form.testMode,
            },
          });
          setForm({ ...form, secret: '' });
          toast(t.common.saved);
          await client.invalidateQueries({ queryKey: ['payments'] });
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="provider-title">
        {t.payment.methods[provider.provider]}{' '}
        {provider.configured ? (
          <Badge tone={provider.isActive ? 'success' : 'neutral'}>
            {t.payments.configured}
          </Badge>
        ) : (
          <Badge>{t.payments.notConfigured}</Badge>
        )}
      </h2>
      <div className="form-grid">
        <TextField
          label={t.payments.merchantId}
          value={form.merchantId}
          onChange={(e) => setForm({ ...form, merchantId: e.target.value })}
          required
        />
        {click && (
          <>
            <TextField
              label={t.payments.serviceId}
              value={form.serviceId}
              onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
              required
            />
            <TextField
              label={`${t.payments.merchantUserId} (${t.common.optional})`}
              value={form.merchantUserId}
              onChange={(e) =>
                setForm({ ...form, merchantUserId: e.target.value })
              }
            />
          </>
        )}
        <TextField
          label={t.payments.secret}
          hint={t.payments.secretHint}
          type="password"
          autoComplete="new-password"
          value={form.secret}
          onChange={(e) => setForm({ ...form, secret: e.target.value })}
          required={!provider.configured}
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <Checkbox
        label={t.payments.testMode}
        checked={form.testMode}
        onChange={(testMode) => setForm({ ...form, testMode })}
      />
      {provider.callbackUrls.length > 0 && (
        <div className="callback-box">
          <span className="field-label">{t.payments.callbackUrls}</span>
          {provider.callbackUrls.map((url) => (
            <code key={url}>{url}</code>
          ))}
        </div>
      )}
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

type Reconciliation = {
  summary: {
    provider: string;
    performedCount: number;
    performedAmount: number;
    cancelledCount: number;
    openCount: number;
    recordedAmount: number;
  }[];
  issues: {
    kind: string;
    provider: string;
    externalId: string | null;
    amount: number;
  }[];
};

function ReconciliationCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ['payments', 'reconciliation', from, to],
    queryFn: () =>
      api<Reconciliation>(`/payments/reconciliation?from=${from}&to=${to}`),
  });
  return (
    <section className="card stack">
      <h2>{t.payments.reconciliation}</h2>
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
      {report.isPending ? (
        <LoadingState />
      ) : report.error ? (
        <ErrorState error={report.error} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th className="right">{t.payments.performed}</th>
                  <th className="right">{t.payments.recorded}</th>
                  <th className="right">{t.payments.cancelled}</th>
                  <th className="right">{t.payments.open}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.summary.map((row) => (
                  <tr key={row.provider}>
                    <td>
                      <strong>
                        {t.payment.methods[row.provider as 'PAYME']}
                      </strong>
                    </td>
                    <td className="right">
                      {row.performedCount} · {formatMoney(row.performedAmount)}
                    </td>
                    <td className="right">{formatMoney(row.recordedAmount)}</td>
                    <td className="right">{row.cancelledCount}</td>
                    <td className="right">{row.openCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.data.issues.length === 0 ? (
            <p className="muted">{t.payments.noIssues}</p>
          ) : (
            <ul className="plain-list danger-text">
              {report.data.issues.map((issue, index) => (
                <li key={index}>
                  {t.payments.issueKinds[issue.kind] ?? issue.kind}:{' '}
                  {issue.provider} {issue.externalId ?? ''} ·{' '}
                  {formatMoney(issue.amount)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PaymentsPage() {
  const { data: me } = useMe();
  const providers = useQuery({
    queryKey: ['payments', 'providers'],
    queryFn: () =>
      api<{ providers: Provider[] }>('/payments/providers').then(
        (data) => data.providers,
      ),
  });
  return (
    <>
      <PageHeader title={t.payments.title} subtitle={t.payments.subtitle} />
      <p className="notice">{t.payments.fiscalNote}</p>
      {providers.isPending ? (
        <LoadingState />
      ) : providers.error ? (
        <ErrorState error={providers.error} />
      ) : (
        <div className="grid-cards">
          {providers.data.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} />
          ))}
        </div>
      )}
      {can(me, 'finance.view') && <ReconciliationCard />}
    </>
  );
}
