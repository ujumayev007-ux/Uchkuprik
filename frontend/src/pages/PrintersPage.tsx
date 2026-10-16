import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStations } from './KitchenPage';

type Printer = {
  id: string;
  name: string;
  kind: 'RECEIPT' | 'KITCHEN';
  stationId: string | null;
  fallbackPrinterId: string | null;
  paperWidth?: number;
  host: string;
  port: number;
  isActive: boolean;
};
type Job = {
  id: string;
  printer: string;
  kind: string;
  purpose: string;
  fallback: boolean;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

function PrinterForm({
  printer,
  branchId,
  others,
  onDone,
}: {
  printer: Printer | null;
  branchId: string;
  others: Printer[];
  onDone: () => void;
}) {
  const stations = useStations();
  const [form, setForm] = useState({
    name: printer?.name ?? '',
    kind: printer?.kind ?? ('KITCHEN' as const),
    stationId: printer?.stationId ?? '',
    fallbackPrinterId: printer?.fallbackPrinterId ?? '',
    paperWidth: printer?.paperWidth ?? 80,
    host: printer?.host ?? '',
    port: printer?.port ?? 9100,
    isActive: printer?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          ...form,
          branchId,
          stationId: form.stationId || null,
          fallbackPrinterId: form.fallbackPrinterId || null,
        };
        try {
          if (printer) await patch(`/printers/${printer.id}`, body);
          else await post('/printers', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <SelectField
          label={t.printers.kind}
          value={form.kind}
          onChange={(e) =>
            setForm({ ...form, kind: e.target.value as Printer['kind'] })
          }
        >
          <option value="KITCHEN">{t.printers.kinds.KITCHEN}</option>
          <option value="RECEIPT">{t.printers.kinds.RECEIPT}</option>
        </SelectField>
        {form.kind === 'KITCHEN' && (
          <SelectField
            label={t.kitchen.station}
            value={form.stationId}
            onChange={(e) => setForm({ ...form, stationId: e.target.value })}
          >
            <option value="">{t.kitchen.noStation}</option>
            {(stations.data ?? []).map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField
          label={t.printers.paper}
          value={
            form.paperWidth === 58 || form.paperWidth === 80
              ? String(form.paperWidth)
              : 'custom'
          }
          onChange={(e) =>
            setForm({
              ...form,
              paperWidth:
                e.target.value === 'custom' ? 72 : Number(e.target.value),
            })
          }
        >
          <option value="80">80 mm</option>
          <option value="58">58 mm</option>
          <option value="custom">{t.receiptTpl.custom}</option>
        </SelectField>
        {form.paperWidth !== 58 && form.paperWidth !== 80 && (
          <TextField
            label={t.receiptTpl.widthMm}
            type="number"
            min={40}
            max={112}
            value={form.paperWidth}
            onChange={(e) =>
              setForm({
                ...form,
                paperWidth: Math.min(
                  112,
                  Math.max(40, Math.round(Number(e.target.value)) || 40),
                ),
              })
            }
          />
        )}
        <SelectField
          label={t.printers.fallback}
          hint={t.printers.fallbackHint}
          value={form.fallbackPrinterId}
          onChange={(e) =>
            setForm({ ...form, fallbackPrinterId: e.target.value })
          }
        >
          <option value="">{t.printers.noFallback}</option>
          {others
            .filter((other) => other.id !== printer?.id)
            .map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
        </SelectField>
        <TextField
          label={t.printers.host}
          hint={t.printers.hostHint}
          value={form.host}
          inputMode="decimal"
          pattern="\d{1,3}(\.\d{1,3}){3}"
          onChange={(e) => setForm({ ...form, host: e.target.value.trim() })}
          required
        />
        <TextField
          label={t.printers.port}
          type="number"
          min={9100}
          max={9109}
          value={form.port}
          onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

export function PrintersPage() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const branchId = me?.activeBranchId ?? '';
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);
  const printers = useQuery({
    queryKey: ['printers', branchId],
    queryFn: () =>
      api<{ printers: Printer[] }>(`/printers?branchId=${branchId}`).then(
        (data) => data.printers,
      ),
    enabled: !!branchId,
  });
  const jobs = useQuery({
    queryKey: ['printers', 'jobs', branchId],
    queryFn: () =>
      api<{ jobs: Job[] }>(`/print-jobs?branchId=${branchId}`).then(
        (data) => data.jobs,
      ),
    enabled: !!branchId,
    refetchInterval: 10_000,
  });
  const action = async (
    fn: () => Promise<unknown>,
    message = t.common.saved,
  ) => {
    try {
      await fn();
      toast(message);
      await client.invalidateQueries({ queryKey: ['printers'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <>
      <PageHeader
        title={t.printers.title}
        subtitle={t.printers.subtitle}
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            + {t.printers.add}
          </Button>
        }
      />
      <p className="notice">{t.printers.agentNote}</p>
      {printers.isPending ? (
        <LoadingState />
      ) : printers.error ? (
        <ErrorState
          error={printers.error}
          onRetry={() => void printers.refetch()}
        />
      ) : printers.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{t.printers.kind}</th>
                <th>{t.printers.host}</th>
                <th>{t.common.status}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {printers.data.map((printer) => (
                <tr key={printer.id}>
                  <td>
                    <strong>{printer.name}</strong>
                  </td>
                  <td>{t.printers.kinds[printer.kind]}</td>
                  <td>
                    <code>
                      {printer.host}:{printer.port}
                    </code>
                  </td>
                  <td>
                    {printer.isActive ? (
                      <Badge tone="success">{t.common.active}</Badge>
                    ) : (
                      <Badge>{t.common.inactive}</Badge>
                    )}
                  </td>
                  <td className="right">
                    <Button
                      size="sm"
                      onClick={() =>
                        void action(
                          () => post(`/printers/${printer.id}/test`),
                          t.printers.testQueued,
                        )
                      }
                    >
                      {t.printers.test}
                    </Button>{' '}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(printer)}
                    >
                      {t.common.edit}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2 className="section-title">{t.printers.jobs}</h2>
      {jobs.data && jobs.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.orders.time}</th>
                <th>{t.printers.title}</th>
                <th>{t.common.status}</th>
                <th>{t.printers.attempts}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((job) => (
                <tr key={job.id}>
                  <td>{formatDateTime(job.createdAt)}</td>
                  <td>
                    {job.printer}
                    {job.purpose === 'UPDATE' && (
                      <small className="muted block">
                        {t.printers.updateTicket}
                      </small>
                    )}
                    {job.fallback && (
                      <small className="muted block">
                        {t.printers.fallbackCopy}
                      </small>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        job.status === 'SENT'
                          ? 'success'
                          : job.status === 'FAILED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t.printers.statuses[job.status]}
                    </Badge>
                    {job.lastError && (
                      <small className="muted block">{job.lastError}</small>
                    )}
                  </td>
                  <td>{job.attempts}</td>
                  <td className="right">
                    {job.status !== 'SENT' && (
                      <Button
                        size="sm"
                        onClick={() =>
                          void action(() => post(`/print-jobs/${job.id}/retry`))
                        }
                      >
                        {t.printers.retry}
                      </Button>
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
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? t.printers.add : t.printers.editTitle}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <PrinterForm
            printer={editing === 'new' ? null : editing}
            branchId={branchId}
            others={printers.data ?? []}
            onDone={async () => {
              setEditing(null);
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['printers'] });
            }}
          />
        )}
      </Dialog>
    </>
  );
}
