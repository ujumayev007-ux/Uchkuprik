import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  FormError,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

const f = t.fiscal;

type Fiscal = {
  enabled: boolean;
  provider: string;
  tin: string;
  terminalId: string;
  hasCredentials: boolean;
  connected: boolean;
};

/** Fiscal (OFD) details; registration needs a certified provider adapter. */
export function FiscalCard() {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['settings', 'fiscal'],
    queryFn: () => api<Fiscal>('/settings/fiscal'),
  });
  const [form, setForm] = useState<Fiscal | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);
  if (!form) return null;
  return (
    <section className="card stack">
      <div className="toolbar">
        <h2 className="section-title">🧾 {f.title}</h2>
        <Badge tone={form.connected ? 'success' : 'warning'}>
          {form.connected ? f.connected : f.notConnected}
        </Badge>
      </div>
      <p className="muted small">{f.hint}</p>
      <Checkbox
        label={f.enabled}
        checked={form.enabled}
        onChange={(enabled) => setForm({ ...form, enabled })}
      />
      <div className="form-grid">
        <TextField
          label={f.provider}
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
        <TextField
          label={f.tin}
          inputMode="numeric"
          value={form.tin}
          onChange={(e) =>
            setForm({ ...form, tin: e.target.value.replace(/\D/g, '') })
          }
        />
        <TextField
          label={f.terminal}
          value={form.terminalId}
          onChange={(e) => setForm({ ...form, terminalId: e.target.value })}
        />
        <TextField
          label={form.hasCredentials ? f.replaceKey : f.key}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button
          variant="primary"
          onClick={async () => {
            setError(null);
            try {
              await api('/settings/fiscal', {
                method: 'PUT',
                body: {
                  enabled: form.enabled,
                  provider: form.provider,
                  tin: form.tin,
                  terminalId: form.terminalId,
                  ...(secret.trim() ? { credentials: secret.trim() } : {}),
                },
              });
              setSecret('');
              toast(t.common.saved);
              await client.invalidateQueries({
                queryKey: ['settings', 'fiscal'],
              });
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          {t.common.save}
        </Button>
      </div>
    </section>
  );
}

/** Completed orders by fiscal status for the chosen period. */
export function FiscalReport({ from, to }: { from: string; to: string }) {
  const report = useQuery({
    queryKey: ['finance', 'fiscal', from, to],
    queryFn: () =>
      api<{
        summary: Record<string, { count: number; total: number }>;
        unregistered: { id: string; number: number; total: number }[];
      }>(`/reports/fiscal?from=${from}&to=${to}`),
  });
  if (!report.data) return null;
  return (
    <section className="card stack">
      <h2 className="section-title">🧾 {f.report}</h2>
      {Object.entries(report.data.summary).map(([status, row]) => (
        <p key={status} className="pair">
          <span>{f.statuses[status] ?? status}</span>
          <strong>
            {row.count} · {formatMoney(row.total)}
          </strong>
        </p>
      ))}
      {Object.keys(report.data.summary).length === 0 && (
        <p className="muted">{t.common.emptyTitle}</p>
      )}
      <p className="muted small">{f.reportHint}</p>
    </section>
  );
}
