import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TextField,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';

const s = t.insights;
type Flag = keyof typeof s.flags;

function Forecast() {
  const forecast = useQuery({
    queryKey: ['insights', 'forecast'],
    queryFn: () =>
      api<{
        forecast: {
          date: string;
          weekday: number;
          revenue: number;
          orders: number;
          basedOnWeeks: number;
        }[];
      }>('/reports/forecast?days=7'),
  });
  if (forecast.isPending) return <LoadingState />;
  if (forecast.error)
    return (
      <ErrorState
        error={forecast.error}
        onRetry={() => void forecast.refetch()}
      />
    );
  const max = Math.max(1, ...forecast.data.forecast.map((row) => row.revenue));
  return (
    <section className="card stack">
      <h2 className="section-title">{s.forecast}</h2>
      <p className="muted small">{s.forecastHint}</p>
      <ul className="ops-list">
        {forecast.data.forecast.map((row) => (
          <li key={row.date} className="ops-item">
            <div className="grow">
              <strong>
                {s.weekdays[row.weekday]} {row.date}
              </strong>
              <div className="usage-bar" aria-hidden="true">
                <span
                  style={{ width: `${Math.round((row.revenue / max) * 100)}%` }}
                />
              </div>
            </div>
            <span className="nowrap">{formatMoney(row.revenue)}</span>
            <span className="muted small nowrap">
              ~{row.orders} {s.orders}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Risk() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(
    new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(today);
  const risk = useQuery({
    queryKey: ['insights', 'risk', from, to],
    queryFn: () =>
      api<{
        employees: {
          userId: string;
          name: string;
          sales: number;
          cancellations: number;
          voids: number;
          refundAmount: number;
          discounts: number;
          cashShortage: number;
          flags: Flag[];
        }[];
      }>(`/reports/risk?from=${from}&to=${to}`),
  });
  return (
    <section className="card stack">
      <div className="toolbar">
        <h2 className="section-title">{s.risk}</h2>
        <TextField
          label={s.from}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField
          label={s.to}
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <p className="muted small">{s.riskHint}</p>
      {risk.isPending ? (
        <LoadingState />
      ) : risk.error ? (
        <ErrorState error={risk.error} onRetry={() => void risk.refetch()} />
      ) : risk.data.employees.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{s.employee}</th>
                <th className="right">{s.sales}</th>
                <th className="right">{s.cancellations}</th>
                <th className="right">{s.voids}</th>
                <th className="right">{s.refunds}</th>
                <th className="right">{s.discounts}</th>
                <th className="right">{s.shortage}</th>
                <th>{s.signals}</th>
              </tr>
            </thead>
            <tbody>
              {risk.data.employees.map((row) => (
                <tr key={row.userId}>
                  <td>{row.name}</td>
                  <td className="right nowrap">{formatMoney(row.sales)}</td>
                  <td className="right">{row.cancellations}</td>
                  <td className="right">{row.voids}</td>
                  <td className="right nowrap">
                    {formatMoney(row.refundAmount)}
                  </td>
                  <td className="right nowrap">{formatMoney(row.discounts)}</td>
                  <td className="right nowrap">
                    {formatMoney(row.cashShortage)}
                  </td>
                  <td>
                    <div className="badges">
                      {row.flags.map((flag) => (
                        <Badge key={flag} tone="danger">
                          {s.flags[flag]}
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function InsightsPage() {
  const { data: me } = useMe();
  return (
    <div className="stack">
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <Forecast />
      {(can(me, 'audit.view') || can(me, 'finance.view')) && <Risk />}
    </div>
  );
}
