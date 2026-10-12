import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { useCurrentShift, type ShiftSummary } from '../lib/orders';

export function ShiftTotals({ summary }: { summary: ShiftSummary }) {
  return (
    <dl className="totals">
      <dt>{t.shift.openingCash}</dt>
      <dd>{formatMoney(summary.shift.openingCash)}</dd>
      {summary.payments.map((row) => (
        <div key={`p-${row.method}`} className="totals-row">
          <dt>
            {t.shift.payments}: {t.payment.methods[row.method]} ({row.count})
          </dt>
          <dd>{formatMoney(row.amount)}</dd>
        </div>
      ))}
      {summary.refunds.map((row) => (
        <div key={`r-${row.method}`} className="totals-row">
          <dt>
            {t.shift.refunds}: {t.payment.methods[row.method]} ({row.count})
          </dt>
          <dd>−{formatMoney(row.amount)}</dd>
        </div>
      ))}
      {summary.movements.map((movement) => (
        <div key={movement.id} className="totals-row">
          <dt>
            {movement.amount > 0 ? t.shift.payIn : t.shift.payOut}:{' '}
            {movement.reason}
          </dt>
          <dd>{formatMoney(movement.amount)}</dd>
        </div>
      ))}
      <dt className="strong">{t.shift.expectedCash}</dt>
      <dd className="strong">{formatMoney(summary.expectedCash)}</dd>
      {summary.shift.countedCash !== null && (
        <>
          <dt>{t.shift.countedCash}</dt>
          <dd>{formatMoney(summary.shift.countedCash)}</dd>
          <dt className="strong">{t.shift.variance}</dt>
          <dd
            className={`strong ${summary.shift.variance && summary.shift.variance < 0 ? 'danger-text' : ''}`}
          >
            {formatMoney(summary.shift.variance ?? 0)}
          </dd>
        </>
      )}
    </dl>
  );
}

export function ShiftPage() {
  const { data: me } = useMe();
  const shift = useCurrentShift();
  const client = useQueryClient();
  const toast = useToast();
  const history = useQuery({
    queryKey: ['shift', 'history', me?.activeBranchId],
    queryFn: () =>
      api<{
        shifts: {
          id: string;
          status: string;
          openedAt: string;
          closedAt: string | null;
          openedBy: string | null;
          expectedCash: number | null;
          countedCash: number | null;
          variance: number | null;
        }[];
      }>(`/shifts?branchId=${me?.activeBranchId}`).then((data) => data.shifts),
    enabled: !!me?.activeBranchId,
  });
  const [opening, setOpening] = useState<number | null>(0);
  const [movement, setMovement] = useState<{
    amount: number | null;
    reason: string;
    out: boolean;
  }>({ amount: null, reason: '', out: true });
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (
    fn: () => Promise<unknown>,
    after?: (value: unknown) => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const value = await fn();
      await client.invalidateQueries({ queryKey: ['shift'] });
      after?.(value);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t.shift.title} subtitle={t.shift.subtitle} />
      {shift.isPending ? (
        <LoadingState />
      ) : shift.error ? (
        <ErrorState error={shift.error} onRetry={() => void shift.refetch()} />
      ) : !shift.data ? (
        <section className="card stack narrow">
          <h2>{t.shift.noShift}</h2>
          <MoneyField
            label={`${t.pos.openingCash} (${t.menu.sum})`}
            value={opening}
            onChange={setOpening}
            required
          />
          <FormError error={error} />
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              void run(() =>
                post('/shifts/open', { openingCash: opening ?? 0 }),
              )
            }
          >
            {t.pos.openShift}
          </Button>
        </section>
      ) : (
        <div className="grid-cards">
          <section className="card stack">
            <h2>
              {t.pos.shiftOpen}{' '}
              <Badge tone="success">
                {formatDateTime(shift.data.shift.openedAt)}
              </Badge>
            </h2>
            <ShiftTotals summary={shift.data} />
            <p className="muted small">
              {t.shift.ordersPaid}: {shift.data.ordersPaid}
            </p>
          </section>
          <section className="card stack">
            <h2>{t.shift.movements}</h2>
            <div className="segmented">
              <button
                className={movement.out ? 'active' : ''}
                aria-pressed={movement.out}
                onClick={() => setMovement({ ...movement, out: true })}
              >
                {t.shift.payOut}
              </button>
              <button
                className={!movement.out ? 'active' : ''}
                aria-pressed={!movement.out}
                onClick={() => setMovement({ ...movement, out: false })}
              >
                {t.shift.payIn}
              </button>
            </div>
            <MoneyField
              label={`${t.payment.amount} (${t.menu.sum})`}
              value={movement.amount}
              onChange={(amount) => setMovement({ ...movement, amount })}
            />
            <TextField
              label={t.shift.reason}
              value={movement.reason}
              onChange={(e) =>
                setMovement({ ...movement, reason: e.target.value })
              }
              minLength={3}
            />
            <Button
              busy={busy}
              disabled={!movement.amount || movement.reason.trim().length < 3}
              onClick={() =>
                void run(
                  () =>
                    post('/shifts/current/movements', {
                      amount: (movement.out ? -1 : 1) * (movement.amount ?? 0),
                      reason: movement.reason,
                    }),
                  () => {
                    setMovement({ amount: null, reason: '', out: true });
                    toast(t.common.saved);
                  },
                )
              }
            >
              {t.common.save}
            </Button>
          </section>
          <section className="card stack">
            <h2>{t.shift.close}</h2>
            <p className="muted small">{t.shift.closeHint}</p>
            <MoneyField
              label={`${t.shift.countedCash} (${t.menu.sum})`}
              value={counted}
              onChange={setCounted}
              required
            />
            <TextField
              label={`${t.pos.note} (${t.common.optional})`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <FormError error={error} />
            <Button
              variant="danger"
              busy={busy}
              disabled={counted === null}
              onClick={() => {
                const id = shift.data!.shift.id;
                void run(
                  () =>
                    post(`/shifts/${id}/close`, {
                      countedCash: counted ?? 0,
                      note: note.trim() || null,
                    }),
                  () => {
                    toast(t.shift.closed);
                    setCounted(null);
                    window.open(
                      `/z-hisobot/${id}`,
                      '_blank',
                      'noopener,width=420,height=760',
                    );
                  },
                );
              }}
            >
              {t.shift.close}
            </Button>
          </section>
        </div>
      )}
      <h2 className="section-title">{t.shift.history}</h2>
      {history.data && history.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.shift.opened}</th>
                <th>{t.shift.openedBy}</th>
                <th className="right">{t.shift.expectedCash}</th>
                <th className="right">{t.shift.countedCash}</th>
                <th className="right">{t.shift.variance}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.map((row) => (
                <tr key={row.id}>
                  <td>{formatDateTime(row.openedAt)}</td>
                  <td>{row.openedBy ?? '—'}</td>
                  <td className="right">
                    {row.expectedCash === null
                      ? '—'
                      : formatMoney(row.expectedCash)}
                  </td>
                  <td className="right">
                    {row.countedCash === null
                      ? '—'
                      : formatMoney(row.countedCash)}
                  </td>
                  <td
                    className={`right ${row.variance && row.variance < 0 ? 'danger-text' : ''}`}
                  >
                    {row.variance === null ? '—' : formatMoney(row.variance)}
                  </td>
                  <td className="right">
                    {row.status === 'CLOSED' &&
                      (can(me, 'reports.view') || can(me, 'shifts.manage')) && (
                        <button
                          className="text-link"
                          onClick={() =>
                            window.open(
                              `/z-hisobot/${row.id}`,
                              '_blank',
                              'noopener,width=420,height=760',
                            )
                          }
                        >
                          {t.shift.zReport}
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
    </>
  );
}
