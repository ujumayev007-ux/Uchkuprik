import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { ownerApi, ownerPost, ownerPut } from '../../lib/owner';

const r = t.owner.registry;

type EventRow = {
  id: string;
  type: string;
  customerId: string | null;
  registrationId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
};
type EventsResponse = { unread: number; events: EventRow[] };

/** Number of unread vendor events (polled while the Owner application is open). */
export function useUnreadEvents() {
  return useQuery({
    queryKey: ['owner', 'events', 'unread'],
    queryFn: () => ownerApi<EventsResponse>('/events?unread=1&limit=1'),
    refetchInterval: 30_000,
    retry: false,
  });
}

const ago = (iso: string) => {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(iso)) / 60_000),
  );
  if (minutes < 1) return r.justNow;
  if (minutes < 60) return r.minutesAgo.replace('{n}', String(minutes));
  if (minutes < 24 * 60)
    return r.hoursAgo.replace('{n}', String(Math.round(minutes / 60)));
  return new Date(iso).toLocaleString('uz-UZ');
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function describe(event: EventRow): string {
  const d = event.data;
  switch (event.type) {
    case 'registration.new':
      return r.events.registration
        .replace('{who}', text(d.restaurantName) || text(d.label))
        .replace('{label}', text(d.label))
        .replace('{version}', text(d.appVersion) || '—');
    case 'trial.assigned':
      return r.events.trialAssigned.replace('{hours}', String(d.hours ?? ''));
    case 'trial.started':
      return r.events.trialStarted
        .replace('{who}', text(d.customerName))
        .replace('{hours}', String(d.hours ?? ''))
        .replace(
          '{end}',
          d.endsAt ? new Date(text(d.endsAt)).toLocaleString('uz-UZ') : '',
        );
    case 'device.activated':
      return r.events.device
        .replace('{who}', text(d.customerName))
        .replace('{label}', text(d.deviceName));
    case 'registration.assigned':
      return r.events.assigned.replace('{who}', text(d.customerName));
    default:
      return event.type;
  }
}

/** Persistent history of registrations and licence events, with an unread marker. */
export function EventsTab({
  onOpenRegistration,
}: {
  onOpenRegistration: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const events = useQuery({
    queryKey: ['owner', 'events', 'list'],
    queryFn: () => ownerApi<EventsResponse>('/events?limit=100'),
    refetchInterval: 30_000,
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['owner', 'events'] });
  const markAll = async () => {
    try {
      await ownerPost('/events/read', { all: true });
      await refresh();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    }
  };
  if (events.isPending) return <LoadingState />;
  if (events.error)
    return (
      <ErrorState error={events.error} onRetry={() => void events.refetch()} />
    );
  return (
    <section className="stack">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{r.eventsTitle}</h2>
        <Badge tone={events.data.unread ? 'danger' : 'neutral'}>
          {r.unread.replace('{n}', String(events.data.unread))}
        </Badge>
        <Button
          disabled={events.data.unread === 0}
          onClick={() => void markAll()}
        >
          {r.markAll}
        </Button>
        <span className="muted small">
          {r.updatedAt.replace(
            '{time}',
            new Date(events.dataUpdatedAt).toLocaleTimeString('uz-UZ'),
          )}
        </span>
      </div>
      {events.data.events.length === 0 ? (
        <EmptyState title={r.noEvents} />
      ) : (
        <ul className="stack">
          {events.data.events.map((event) => (
            <li key={event.id} className={`card ${event.read ? '' : 'accent'}`}>
              <div className="toolbar">
                {!event.read && <Badge tone="danger">{r.new}</Badge>}
                <strong>{describe(event)}</strong>
                <span className="muted small">{ago(event.createdAt)}</span>
                {event.registrationId && (
                  <Button size="sm" onClick={onOpenRegistration}>
                    {r.open}
                  </Button>
                )}
                {!event.read && (
                  <Button
                    size="sm"
                    onClick={() =>
                      void ownerPost('/events/read', { ids: [event.id] }).then(
                        refresh,
                      )
                    }
                  >
                    {r.markRead}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Registration = {
  id: string;
  installId: string;
  label: string;
  restaurantName: string | null;
  platform: string;
  appVersion: string | null;
  installedAt: string | null;
  hasLocalLicense: boolean;
  status: 'PENDING' | 'ASSIGNED' | 'REJECTED';
  customerId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  license: {
    status: string;
    trial: boolean;
    trialStartedAt: string | null;
    endsAt: string | null;
    waitingForActivation: boolean;
  } | null;
};

const licenseText = (row: Registration) => {
  const license = row.license;
  if (!license) return row.hasLocalLicense ? r.localLicense : '—';
  if (license.trial)
    return license.waitingForActivation
      ? r.trialWaiting
      : r.trialUntil.replace(
          '{end}',
          license.endsAt
            ? new Date(license.endsAt).toLocaleString('uz-UZ')
            : '',
        );
  return r.licensed;
};

/** Installations that announced themselves: search, assign to a customer, trial or licence. */
export function RegistrationsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [assign, setAssign] = useState<Registration | null>(null);
  const list = useQuery({
    queryKey: ['owner', 'registrations', status, q],
    queryFn: () =>
      ownerApi<{ registrations: Registration[] }>(
        `/registrations?${status ? `status=${status}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`,
      ),
    refetchInterval: 30_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['owner'] });
  return (
    <section className="stack">
      <RegistrySettings />
      <div className="toolbar">
        <TextField
          label={t.common.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={r.searchHint}
        />
        <SelectField
          label={r.statusLabel}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{r.statusAll}</option>
          <option value="PENDING">{r.status.PENDING}</option>
          <option value="ASSIGNED">{r.status.ASSIGNED}</option>
          <option value="REJECTED">{r.status.REJECTED}</option>
        </SelectField>
      </div>
      {list.isPending ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.registrations.length === 0 ? (
        <EmptyState title={r.noRegistrations} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{r.colRestaurant}</th>
                <th>{r.colVersion}</th>
                <th>{r.colRegistered}</th>
                <th>{r.colLastContact}</th>
                <th>{r.colLicense}</th>
                <th>{r.statusLabel}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.registrations.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.restaurantName ?? row.label}</strong>
                    <br />
                    <span className="muted small">
                      {row.label} · {row.installId}
                    </span>
                  </td>
                  <td>{row.appVersion ?? '—'}</td>
                  <td>{new Date(row.firstSeenAt).toLocaleString('uz-UZ')}</td>
                  <td>{ago(row.lastSeenAt)}</td>
                  <td>{licenseText(row)}</td>
                  <td>
                    <Badge
                      tone={
                        row.status === 'PENDING'
                          ? 'warning'
                          : row.status === 'ASSIGNED'
                            ? 'success'
                            : 'neutral'
                      }
                    >
                      {r.status[row.status]}
                    </Badge>
                  </td>
                  <td>
                    {row.status === 'PENDING' && (
                      <div className="toolbar">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setAssign(row)}
                        >
                          {r.assign}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            void ownerPost(`/registrations/${row.id}/reject`)
                              .then(refresh)
                              .catch((error: unknown) =>
                                toast(
                                  error instanceof Error
                                    ? error.message
                                    : t.common.errorTitle,
                                  'error',
                                ),
                              )
                          }
                        >
                          {r.reject}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {assign && (
        <AssignDialog
          registration={assign}
          onClose={() => setAssign(null)}
          onDone={() => {
            setAssign(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function RegistrySettings() {
  const toast = useToast();
  const settings = useQuery({
    queryKey: ['owner', 'registry-settings'],
    queryFn: () =>
      ownerApi<{ autoTrial: boolean; trialHours: number }>(
        '/registry-settings',
      ),
  });
  const [draft, setDraft] = useState<{
    autoTrial: boolean;
    trialHours: string;
  } | null>(null);
  const value =
    draft ??
    (settings.data
      ? {
          autoTrial: settings.data.autoTrial,
          trialHours: String(settings.data.trialHours),
        }
      : null);
  if (!value) return null;
  return (
    <fieldset className="stack">
      <legend>{r.settingsTitle}</legend>
      <Checkbox
        label={r.autoTrial}
        checked={value.autoTrial}
        onChange={(on) => setDraft({ ...value, autoTrial: on })}
      />
      <TextField
        label={r.trialHours}
        inputMode="numeric"
        value={value.trialHours}
        onChange={(e) =>
          setDraft({ ...value, trialHours: e.target.value.replace(/\D/g, '') })
        }
      />
      <p className="muted small">{r.trialRule}</p>
      <Button
        variant="primary"
        onClick={() =>
          void ownerPut('/registry-settings', {
            autoTrial: value.autoTrial,
            trialHours: Number(value.trialHours || '72'),
          })
            .then(() => {
              setDraft(null);
              toast(t.common.saved);
              return settings.refetch();
            })
            .catch((error: unknown) =>
              toast(
                error instanceof Error ? error.message : t.common.errorTitle,
                'error',
              ),
            )
        }
      >
        {t.common.save}
      </Button>
    </fieldset>
  );
}

function AssignDialog({
  registration,
  onClose,
  onDone,
}: {
  registration: Registration;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const customers = useQuery({
    queryKey: ['owner', 'customers', 'names'],
    queryFn: () =>
      ownerApi<{ customers: { id: string; name: string }[] }>('/customers'),
  });
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState(
    registration.restaurantName ?? registration.label,
  );
  const [mode, setMode] = useState<'trial' | 'months'>('trial');
  const [amount, setAmount] = useState('72');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await ownerPost(`/registrations/${registration.id}/assign`, {
        ...(customerId ? { customerId } : { newCustomer: { name } }),
        mode,
        ...(mode === 'trial'
          ? { trialHours: Number(amount || '72') }
          : { months: Number(amount || '1') }),
      });
      toast(r.assigned);
      onDone();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={r.assignTitle}
      description={`${registration.restaurantName ?? registration.label} · ${registration.installId}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!customerId && name.trim().length < 2}
            onClick={() => void send()}
          >
            {r.assign}
          </Button>
        </>
      }
    >
      <div className="stack">
        <SelectField
          label={r.existingCustomer}
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          <option value="">{r.newCustomer}</option>
          {(customers.data?.customers ?? []).map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </SelectField>
        {!customerId && (
          <TextField
            label={r.customerName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        )}
        <SelectField
          label={r.modeLabel}
          value={mode}
          onChange={(e) => {
            const next = e.target.value as 'trial' | 'months';
            setMode(next);
            setAmount(next === 'trial' ? '72' : '1');
          }}
        >
          <option value="trial">{r.modeTrial}</option>
          <option value="months">{r.modeLicense}</option>
        </SelectField>
        <TextField
          label={mode === 'trial' ? r.hoursLabel : r.monthsLabel}
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
        />
        <p className="muted small">
          {mode === 'trial' ? r.trialRule : r.licenseRule}
        </p>
      </div>
    </Dialog>
  );
}
