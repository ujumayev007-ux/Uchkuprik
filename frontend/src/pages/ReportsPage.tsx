import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TextField,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { PaymentMethod } from '../lib/orders';
import { ReportExportCard } from './ReportExportCard';

type SalesReport = {
  from: string;
  to: string;
  orders: number;
  cancelledOrders: number;
  salesTotal: number;
  discounts: number;
  averageCheck: number;
  collected: number;
  payments: { method: PaymentMethod; amount: number; count: number }[];
  refunds: { method: PaymentMethod; amount: number; count: number }[];
  topProducts: { name: string; quantity: number; revenue: number }[];
  cashiers: { name: string; amount: number; count: number }[];
  profit?: { costOfGoods: number; grossProfit: number; marginBp: number };
};

const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
};

export function ReportsPage() {
  const { data: me } = useMe();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ['reports', 'sales', me?.activeBranchId, from, to],
    queryFn: () =>
      api<SalesReport>(
        `/reports/sales?branchId=${me?.activeBranchId}&from=${from}&to=${to}`,
      ),
    enabled: !!me?.activeBranchId && !!from && !!to,
  });
  const r = report.data;
  return (
    <>
      <PageHeader title={t.reports.title} subtitle={t.reports.subtitle} />
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
      {me?.activeBranchId && from && to && (
        <ReportExportCard branchId={me.activeBranchId} from={from} to={to} />
      )}
      {report.isPending ? (
        <LoadingState />
      ) : report.error ? (
        <ErrorState
          error={report.error}
          onRetry={() => void report.refetch()}
        />
      ) : !r ? (
        <EmptyState />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span>{t.reports.sales}</span>
              <strong>{formatMoney(r.salesTotal)}</strong>
            </div>
            <div className="stat">
              <span>{t.reports.orders}</span>
              <strong>{r.orders}</strong>
              <small className="muted">
                {t.reports.cancelled}: {r.cancelledOrders}
              </small>
            </div>
            <div className="stat">
              <span>{t.reports.averageCheck}</span>
              <strong>{formatMoney(r.averageCheck)}</strong>
            </div>
            <div className="stat">
              <span>{t.reports.collected}</span>
              <strong>{formatMoney(r.collected)}</strong>
              <small className="muted">
                {t.reports.discounts}: {formatMoney(r.discounts)}
              </small>
            </div>
            {r.profit && (
              <div className="stat accent">
                <span>{t.reports.profit}</span>
                <strong>{formatMoney(r.profit.grossProfit)}</strong>
                <small className="muted">
                  {t.reports.costOfGoods}: {formatMoney(r.profit.costOfGoods)} ·{' '}
                  {t.reports.margin}: {(r.profit.marginBp / 100).toFixed(1)}%
                </small>
              </div>
            )}
          </div>
          <div className="grid-cards">
            <section className="card">
              <h2>{t.reports.byMethod}</h2>
              {r.payments.length === 0 ? (
                <p className="muted">{t.common.emptyTitle}</p>
              ) : (
                <dl className="totals">
                  {r.payments.map((row) => (
                    <div key={row.method} className="totals-row">
                      <dt>
                        {t.payment.methods[row.method]} ({row.count})
                      </dt>
                      <dd>{formatMoney(row.amount)}</dd>
                    </div>
                  ))}
                  {r.refunds.map((row) => (
                    <div
                      key={`r-${row.method}`}
                      className="totals-row danger-text"
                    >
                      <dt>
                        {t.shift.refunds}: {t.payment.methods[row.method]}
                      </dt>
                      <dd>−{formatMoney(row.amount)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
            <section className="card">
              <h2>{t.reports.cashiers}</h2>
              <dl className="totals">
                {r.cashiers.map((row) => (
                  <div key={row.name} className="totals-row">
                    <dt>
                      {row.name} ({row.count})
                    </dt>
                    <dd>{formatMoney(row.amount)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
          <h2 className="section-title">{t.reports.topProducts}</h2>
          {r.topProducts.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.menu.productName}</th>
                    <th className="right">{t.reports.quantity}</th>
                    <th className="right">{t.reports.revenue}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.topProducts.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td className="right">{row.quantity}</td>
                      <td className="right">{formatMoney(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
