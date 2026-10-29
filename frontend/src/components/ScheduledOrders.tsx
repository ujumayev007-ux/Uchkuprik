import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  TextField,
  useToast,
} from './ui';

const s = t.scheduled;

type ZoneSummary = {
  payment: string;
  scheduling: boolean;
  scheduleLeadMinutes: number;
};
/** The restaurant's active workflow as staff screens need it. */
export function useActiveWorkflow() {
  return useQuery({
    queryKey: ['workflow', 'active'],
    queryFn: () =>
      api<{ enabled: boolean; zones: Record<string, ZoneSummary> }>(
        '/workflow/active',
      ),
    staleTime: 60_000,
    retry: false,
  });
}
export const schedulingOn = (workflow?: {
  enabled: boolean;
  zones: Record<string, ZoneSummary>;
}) =>
  !!workflow?.enabled &&
  Object.values(workflow.zones).some((z) => z.scheduling);

type Row = {
  id: string;
  number: number;
  status: string;
  scheduledFor: string;
  confirmed: boolean;
  guests: number | null;
  eventName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  table: string | null;
  total: number;
  paid: number;
  leadMinutes: number;
};

// datetime-local wants the local time without a zone.
const localInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** Banketlar va rejalashtirilgan buyurtmalar of the active branch. */
export function ScheduledOrders({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const list = useQuery({
    queryKey: ['orders', 'scheduled', me?.activeBranchId],
    queryFn: () =>
      api<{ orders: Row[] }>(
        `/scheduled-orders?branchId=${me?.activeBranchId}`,
      ).then((data) => data.orders),
    enabled: !!me?.activeBranchId,
    refetchInterval: 30_000,
  });
  const run = async (work: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await work();
      toast(done);
      await client.invalidateQueries({ queryKey: ['orders'] });
    } catch (caught) {
      setError(caught);
    }
  };
  if (list.isPending) return <LoadingState />;
  if (list.error)
    return (
      <ErrorState error={list.error} onRetry={() => void list.refetch()} />
    );
  return (
    <div className="stack">
      <p className="muted small">{s.hint}</p>
      <FormError error={error} />
      {list.data.length === 0 ? (
        <EmptyState title={s.none} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{s.at}</th>
                <th>{t.orders.number}</th>
                <th>{s.event}</th>
                <th className="right">{s.guests}</th>
                <th className="right">{s.paid}</th>
                <th>{t.common.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((row) => (
                <tr
                  key={row.id}
                  className="clickable"
                  onClick={() => onSelect(row.id)}
                >
                  <td>
                    <strong>{formatDateTime(row.scheduledFor)}</strong>
                    <div className="muted small">
                      {s.lead.replace('{n}', String(row.leadMinutes))}
                    </div>
                  </td>
                  <td>
                    {t.orders.number}
                    {row.number}
                    {row.table && (
                      <div className="muted small">{row.table}</div>
                    )}
                  </td>
                  <td>
                    {row.eventName ?? '—'}
                    {(row.customerName || row.customerPhone) && (
                      <div className="muted small">
                        {[row.customerName, row.customerPhone]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="right">{row.guests ?? '—'}</td>
                  <td className="right">
                    {formatMoney(row.paid)} / {formatMoney(row.total)}
                  </td>
                  <td>
                    {row.status === 'PENDING' ? (
                      row.confirmed ? (
                        <Badge tone="success">{s.confirmed}</Badge>
                      ) : (
                        <Badge tone="warning">{s.waitingApproval}</Badge>
                      )
                    ) : row.status === 'DRAFT' ? (
                      <Badge>{s.draft}</Badge>
                    ) : (
                      <Badge tone="accent">{s.sent}</Badge>
                    )}
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {row.status === 'PENDING' && !row.confirmed && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void run(
                            () => post(`/orders/${row.id}/approve`),
                            s.confirmed,
                          )
                        }
                      >
                        {s.approve}
                      </Button>
                    )}
                    {row.status === 'PENDING' &&
                      row.confirmed &&
                      (can(me, 'orders.approve') ||
                        can(me, 'payments.accept')) && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            void run(
                              () => post(`/orders/${row.id}/release`),
                              s.released,
                            )
                          }
                        >
                          {s.release}
                        </Button>
                      )}
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

/** Set or move the time of a draft / waiting order (banquet, scheduled order). */
export function ScheduleDialog({
  order,
  leadMinutes,
  onClose,
}: {
  order: {
    id: string;
    scheduledFor?: string | null;
    guests?: number | null;
    eventName?: string | null;
  };
  leadMinutes: number;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [at, setAt] = useState(localInput(order.scheduledFor));
  const [guests, setGuests] = useState(
    order.guests ? String(order.guests) : '',
  );
  const [eventName, setEventName] = useState(order.eventName ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async (scheduledFor: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/orders/${order.id}/schedule`, {
        scheduledFor,
        guests: guests ? Number(guests) : null,
        eventName: eventName.trim() || null,
      });
      toast(s.saved);
      await client.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title={s.dialogTitle} onClose={onClose}>
      <div className="stack">
        <p className="muted small">
          {s.dialogHint.replace('{n}', String(leadMinutes))}
        </p>
        <div className="form-grid">
          <TextField
            label={s.at}
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            required
          />
          <TextField
            label={s.guests}
            type="number"
            min={1}
            max={5000}
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
          />
          <TextField
            label={s.event}
            value={eventName}
            maxLength={120}
            onChange={(e) => setEventName(e.target.value)}
          />
        </div>
        <FormError error={error} />
        <div className="form-actions">
          <Button
            variant="primary"
            busy={busy}
            disabled={!at}
            onClick={() => void save(new Date(at).toISOString())}
          >
            {s.save}
          </Button>
          {order.scheduledFor && (
            <Button busy={busy} onClick={() => void save(null)}>
              {s.remove}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
