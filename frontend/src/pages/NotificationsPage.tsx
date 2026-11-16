import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useBranches } from '../components/AppShell';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const n = t.notifications;
type Tab = keyof typeof n.tabs;
type EventKey = keyof typeof n.events;

type Settings = {
  configured: boolean;
  botUsername: string | null;
  isActive: boolean;
  dailySummaryHour: number | null;
  dailySummaryMinute?: number;
  receiver?: 'WEBHOOK' | 'POLLING' | 'CONFLICT';
  ordersEnabled?: boolean;
  receiptsEnabled?: boolean;
  orderBranchId?: string | null;
  webhookUrl: string;
  events: EventKey[];
};
type LinkState = keyof typeof n.states;
type Subscriber = {
  id: string;
  name: string;
  // Masked («…1234»): the number itself is not shown again.
  chatId: string | null;
  linked: boolean;
  state: LinkState;
  linkExpiresAt: string | null;
  events: EventKey[];
  branchIds: string[];
  isActive: boolean;
  financial: boolean;
  staff: boolean;
  linkedAt: string | null;
};
type Job = {
  id: string;
  event: string;
  text: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  recipient?: string | null;
};

/** A delivery error code → what to do, in Uzbek. */
export function explainError(code: string | null) {
  if (!code) return '';
  const known = (n.errors as Record<string, string>)[code];
  if (known) return known;
  return n.errors.other.replace('{code}', code.replace(/^TG_ERROR_/, ''));
}

const stateTone: Record<
  LinkState,
  'success' | 'warning' | 'danger' | 'neutral'
> = {
  LINKED: 'success',
  PENDING: 'warning',
  EXPIRED: 'danger',
  NOT_LINKED: 'neutral',
};

/**
 * «Telegram’da ulash»: a QR code for the phone and a button for this computer; the
 * recipient only presses «Start» in Telegram. The list refreshes itself, so the
 * dialog turns into «Qabul qiluvchi ulandi» on its own.
 */
function LinkDialog({
  subscriber,
  onClose,
}: {
  subscriber: Subscriber;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [link, setLink] = useState<{
    url: string;
    expiresAt: string;
    receiver: 'WEBHOOK' | 'POLLING' | 'CONFLICT';
  } | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    post<{
      url: string;
      expiresAt: string;
      receiver: 'WEBHOOK' | 'POLLING' | 'CONFLICT';
    }>(`/notifications/subscribers/${subscriber.id}/link`)
      .then(async (data) => {
        if (cancelled) return;
        setLink(data);
        const { default: QRCode } = await import('qrcode');
        const image = await QRCode.toString(data.url, {
          type: 'svg',
          margin: 1,
          width: 240,
        });
        if (!cancelled) setSvg(image);
        void client.invalidateQueries({ queryKey: ['notifications'] });
      })
      .catch((caught) => !cancelled && setError(caught));
    return () => {
      cancelled = true;
    };
  }, [subscriber.id, client]);
  // Watch for «Start» (the list query refreshes every few seconds while open).
  const list = useQuery({
    queryKey: ['notifications', 'subscribers'],
    queryFn: () =>
      api<{ subscribers: Subscriber[] }>('/notifications/subscribers').then(
        (data) => data.subscribers,
      ),
    refetchInterval: 3000,
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const current = list.data?.find((row) => row.id === subscriber.id);
  const linkedNow = current?.state === 'LINKED';
  const expired =
    !!link && !linkedNow && new Date(link.expiresAt).getTime() <= now;
  return (
    <Dialog open title={`${n.linkTitle}: ${subscriber.name}`} onClose={onClose}>
      <div className="stack telegram-link">
        <FormError error={error} />
        {linkedNow ? (
          <p className="telegram-link-done">✅ {n.linkDone}</p>
        ) : expired ? (
          <p className="danger-text">{n.linkExpiredNow}</p>
        ) : link ? (
          <>
            <p>{n.linkInstructions}</p>
            {svg && (
              <div
                className="telegram-link-qr"
                // Generated locally by the qrcode library from the deep link.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
            <a
              className="btn btn-primary btn-lg"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {n.openTelegram}
            </a>
            <p className="muted small">
              {n.linkExpires.replace(
                '{time}',
                new Date(link.expiresAt).toLocaleTimeString('uz-UZ', {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              )}
            </p>
            <Badge tone="warning">{n.states.PENDING}</Badge>
            <p
              className={`small ${link.receiver === 'CONFLICT' ? 'danger-text' : 'muted'}`}
            >
              {n.receiver[link.receiver]}
            </p>
          </>
        ) : (
          !error && <LoadingState />
        )}
      </div>
    </Dialog>
  );
}

/** «Sinov xabari» for one recipient, following it until Telegram answers. */
function TestDialog({
  subscriber,
  onClose,
}: {
  subscriber: Subscriber;
  onClose: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    post<{ jobId: string }>(
      `/notifications/subscribers/${subscriber.id}/test`,
      {
        requestId: crypto.randomUUID(),
      },
    )
      .then((data) => !cancelled && setJobId(data.jobId))
      .catch((caught) => !cancelled && setError(caught));
    return () => {
      cancelled = true;
    };
  }, [subscriber.id]);
  const job = useQuery({
    queryKey: ['notifications', 'job', jobId],
    queryFn: () => api<Job>(`/notifications/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? 2000 : false,
  });
  const status = job.data?.status;
  return (
    <Dialog open title={`${n.testOne}: ${subscriber.name}`} onClose={onClose}>
      <div className="stack">
        <FormError error={error} />
        {status && (
          <div>
            <Badge
              tone={
                status === 'SENT'
                  ? 'success'
                  : status === 'FAILED'
                    ? 'danger'
                    : 'warning'
              }
            >
              {n.testState[status]}
            </Badge>
          </div>
        )}
        {job.data?.lastError && (
          <p className={status === 'FAILED' ? 'danger-text' : 'muted small'}>
            {explainError(job.data.lastError)}
          </p>
        )}
        {!status && !error && <LoadingState />}
      </div>
    </Dialog>
  );
}

function useAction() {
  const toast = useToast();
  const client = useQueryClient();
  return async (run: () => Promise<unknown>, done: string = t.common.saved) => {
    try {
      await run();
      toast(done);
      await client.invalidateQueries({ queryKey: ['notifications'] });
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };
}

function SettingsTab({ settings }: { settings: Settings }) {
  const action = useAction();
  const [token, setToken] = useState('');
  const [isActive, setActive] = useState(
    settings.isActive || !settings.configured,
  );
  const branches = useBranches();
  const [ordersEnabled, setOrdersEnabled] = useState(!!settings.ordersEnabled);
  const [receiptsEnabled, setReceiptsEnabled] = useState(
    !!settings.receiptsEnabled,
  );
  const [orderBranchId, setOrderBranchId] = useState(
    settings.orderBranchId ?? '',
  );
  const [hour, setHour] = useState(
    settings.dailySummaryHour === null ? '' : String(settings.dailySummaryHour),
  );
  const [minute, setMinute] = useState(
    String(settings.dailySummaryMinute ?? 0),
  );
  return (
    <form
      className="card stack"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await action(() =>
            api('/notifications/telegram', {
              method: 'PUT',
              body: {
                ...(token.trim() ? { botToken: token.trim() } : {}),
                isActive,
                dailySummaryHour: hour === '' ? null : Number(hour),
                dailySummaryMinute: Number(minute),
                ordersEnabled,
                receiptsEnabled,
                orderBranchId: orderBranchId || null,
              },
            }),
          )
        )
          setToken('');
      }}
    >
      <p className="muted">
        {settings.configured
          ? `✅ ${n.botReady}: @${settings.botUsername ?? '—'}`
          : n.notConfigured}
      </p>
      {settings.configured && settings.receiver && (
        <p
          className={`small ${settings.receiver === 'CONFLICT' ? 'danger-text' : 'muted'}`}
        >
          {n.receiver[settings.receiver]}
        </p>
      )}
      <TextField
        label={settings.configured ? n.replaceToken : n.botToken}
        hint={n.tokenHint}
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        required={!settings.configured}
      />
      <SelectField
        label={n.summaryHour}
        value={hour}
        onChange={(event) => setHour(event.target.value)}
      >
        <option value="">{n.summaryOff}</option>
        {Array.from({ length: 24 }, (_, value) => (
          <option key={value} value={value}>
            {String(value).padStart(2, '0')}:{minute.padStart(2, '0')}
          </option>
        ))}
      </SelectField>
      {hour !== '' && (
        <SelectField
          label={n.summaryMinute}
          value={minute}
          onChange={(event) => setMinute(event.target.value)}
        >
          {[0, 10, 15, 20, 30, 40, 45, 50].map((value) => (
            <option key={value} value={value}>
              {String(value).padStart(2, '0')}
            </option>
          ))}
        </SelectField>
      )}
      <Checkbox
        label={t.common.active}
        checked={isActive}
        onChange={setActive}
      />
      <fieldset className="stack">
        <legend>🧾 {t.eReceipt.telegramTitle}</legend>
        <Checkbox
          label={t.eReceipt.telegramEnable}
          checked={receiptsEnabled}
          onChange={setReceiptsEnabled}
        />
        <p className="muted small">{t.eReceipt.telegramHint}</p>
      </fieldset>
      <fieldset className="stack">
        <legend>🛒 {t.telegramOrders.title}</legend>
        <Checkbox
          label={t.telegramOrders.enable}
          checked={ordersEnabled}
          onChange={setOrdersEnabled}
        />
        <p className="muted small">{t.telegramOrders.hint}</p>
        {ordersEnabled && (branches.data ?? []).length > 1 && (
          <SelectField
            label={t.telegramOrders.branch}
            value={orderBranchId}
            onChange={(event) => setOrderBranchId(event.target.value)}
          >
            <option value="">{t.telegramOrders.firstBranch}</option>
            {(branches.data ?? []).map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </SelectField>
        )}
      </fieldset>
      <p className="muted small">
        {n.webhook}: <code>{settings.webhookUrl}</code>
      </p>
      <div className="form-actions">
        {settings.configured && (
          <Button
            onClick={() =>
              void action(() => post('/notifications/test'), n.testQueued)
            }
          >
            {n.test}
          </Button>
        )}
        <Button type="submit" variant="primary">
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function SubscriberForm({
  subscriber,
  events,
  onDone,
}: {
  subscriber: Subscriber | null;
  events: EventKey[];
  onDone: (created: Subscriber | null) => void;
}) {
  const branches = useBranches();
  const [form, setForm] = useState({
    name: subscriber?.name ?? '',
    // The manual fallback starts empty (the linked number is not shown again).
    chatId: '',
    events: subscriber?.events ?? events,
    branchIds: subscriber?.branchIds ?? [],
    isActive: subscriber?.isActive ?? true,
    financial: subscriber?.financial ?? false,
    staff: subscriber?.staff ?? false,
  });
  const [error, setError] = useState<unknown>(null);
  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((item) => item !== value);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const body = { ...form, chatId: form.chatId.trim() || null };
        try {
          if (subscriber) {
            await api(`/notifications/subscribers/${subscriber.id}`, {
              method: 'PUT',
              body,
            });
            onDone(null);
          } else {
            const created = await post<{ id: string }>(
              '/notifications/subscribers',
              body,
            );
            // A new recipient without a manual chat ID goes straight to linking.
            onDone(
              body.chatId
                ? null
                : ({
                    id: created.id,
                    name: form.name,
                    chatId: null,
                    linked: false,
                    state: 'NOT_LINKED',
                    linkExpiresAt: null,
                    events: form.events,
                    branchIds: form.branchIds,
                    isActive: form.isActive,
                    financial: form.financial,
                    staff: form.staff,
                    linkedAt: null,
                  } satisfies Subscriber),
            );
          }
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <TextField
        label={t.common.name}
        value={form.name}
        minLength={2}
        onChange={(event) => setForm({ ...form, name: event.target.value })}
        required
      />
      <fieldset>
        <legend>{n.eventsTitle}</legend>
        <div className="check-grid">
          {events.map((key) => {
            // Employee messages need the staff permission below.
            const needsStaff =
              key === 'attendance.in' || key === 'attendance.out';
            return (
              <Checkbox
                key={key}
                label={n.events[key]}
                checked={form.events.includes(key)}
                disabled={needsStaff && !form.staff}
                onChange={(on) =>
                  setForm({ ...form, events: toggle(form.events, key, on) })
                }
              />
            );
          })}
        </div>
      </fieldset>
      <fieldset className="stack">
        <Checkbox
          label={n.financial}
          checked={form.financial}
          onChange={(financial) => setForm({ ...form, financial })}
        />
        <Checkbox
          label={n.staff}
          checked={form.staff}
          onChange={(staff) =>
            setForm({
              ...form,
              staff,
              events: staff
                ? form.events
                : form.events.filter((key) => !key.startsWith('attendance.')),
            })
          }
        />
      </fieldset>
      <fieldset>
        <legend>{n.branches}</legend>
        <div className="check-grid">
          {(branches.data ?? []).map((branch) => (
            <Checkbox
              key={branch.id}
              label={branch.name}
              checked={form.branchIds.includes(branch.id)}
              onChange={(on) =>
                setForm({
                  ...form,
                  branchIds: toggle(form.branchIds, branch.id, on),
                })
              }
            />
          ))}
        </div>
        <p className="muted small">{n.allBranchesHint}</p>
      </fieldset>
      <Checkbox
        label={n.pause}
        description={n.pausedHint}
        checked={!form.isActive}
        onChange={(paused) => setForm({ ...form, isActive: !paused })}
      />
      <details>
        <summary>{n.advanced}</summary>
        <TextField
          label={`${n.chatId} (${t.common.optional})`}
          hint={n.chatIdHint}
          inputMode="numeric"
          pattern="-?\d{1,20}"
          value={form.chatId}
          onChange={(event) => setForm({ ...form, chatId: event.target.value })}
        />
      </details>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary">
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function SubscribersTab({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Subscriber | 'new' | null>(null);
  const [linking, setLinking] = useState<Subscriber | null>(null);
  const [testing, setTesting] = useState<Subscriber | null>(null);
  const subscribers = useQuery({
    queryKey: ['notifications', 'subscribers'],
    queryFn: () =>
      api<{ subscribers: Subscriber[] }>('/notifications/subscribers').then(
        (data) => data.subscribers,
      ),
    // A pending link turns into «ulandi» by itself.
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.state === 'PENDING') ? 4000 : false,
  });
  const ready =
    settings.configured && settings.isActive && !!settings.botUsername;
  return (
    <div className="stack">
      <div className="toolbar">
        {ready && (
          <Badge tone="success">
            ✅ {n.botReady}: @{settings.botUsername}
          </Badge>
        )}
        <span className="spacer" />
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {n.addSubscriber}
        </Button>
      </div>
      {settings.receiver === 'CONFLICT' && (
        <p className="danger-text small">{n.receiver.CONFLICT}</p>
      )}
      {subscribers.isPending ? (
        <LoadingState />
      ) : subscribers.error ? (
        <ErrorState
          error={subscribers.error}
          onRetry={() => void subscribers.refetch()}
        />
      ) : subscribers.data.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="ops-list">
          {subscribers.data.map((row) => (
            <li key={row.id} className="ops-item">
              <div className="grow">
                <strong>{row.name}</strong>{' '}
                {!row.isActive && <Badge tone="neutral">⏸ {n.paused}</Badge>}
                <div className="muted small">
                  {row.events.map((key) => n.events[key]).join(', ') || '—'}
                </div>
              </div>
              <Badge tone={stateTone[row.state]}>{n.states[row.state]}</Badge>
              {row.state !== 'LINKED' && ready && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setLinking(row)}
                >
                  {n.linkButton}
                </Button>
              )}
              {row.state === 'LINKED' && (
                <Button size="sm" onClick={() => setTesting(row)}>
                  {n.testOne}
                </Button>
              )}
              <Button size="sm" onClick={() => setEditing(row)}>
                {t.common.edit}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={editing !== null}
        title={n.addSubscriber}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <SubscriberForm
            subscriber={editing === 'new' ? null : editing}
            events={settings.events}
            onDone={(created) => {
              setEditing(null);
              if (created && ready) setLinking(created);
              void client.invalidateQueries({ queryKey: ['notifications'] });
            }}
          />
        )}
      </Dialog>
      {linking && (
        <LinkDialog subscriber={linking} onClose={() => setLinking(null)} />
      )}
      {testing && (
        <TestDialog subscriber={testing} onClose={() => setTesting(null)} />
      )}
    </div>
  );
}

function TemplatesTab() {
  const action = useAction();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const templates = useQuery({
    queryKey: ['notifications', 'templates'],
    queryFn: () =>
      api<{
        templates: {
          event: EventKey;
          body: string;
          isDefault: boolean;
          defaultBody: string;
        }[];
      }>('/notifications/templates').then((data) => data.templates),
  });
  if (templates.isPending) return <LoadingState />;
  if (templates.error)
    return (
      <ErrorState
        error={templates.error}
        onRetry={() => void templates.refetch()}
      />
    );
  return (
    <div className="stack">
      <p className="muted small">{n.templateHint}</p>
      {templates.data.map((row) => {
        const value = drafts[row.event] ?? row.body;
        return (
          <section key={row.event} className="card stack">
            <Field label={n.events[row.event]}>
              {(id) => (
                <textarea
                  id={id}
                  rows={5}
                  value={value}
                  onChange={(event) =>
                    setDrafts({ ...drafts, [row.event]: event.target.value })
                  }
                />
              )}
            </Field>
            <div className="form-actions">
              {!row.isDefault && (
                <Button
                  onClick={() =>
                    void action(() =>
                      api(`/notifications/templates/${row.event}`, {
                        method: 'PUT',
                        body: { body: '' },
                      }),
                    )
                  }
                >
                  {n.resetTemplate}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() =>
                  void action(() =>
                    api(`/notifications/templates/${row.event}`, {
                      method: 'PUT',
                      body: { body: value },
                    }),
                  )
                }
              >
                {t.common.save}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DeliveryTab() {
  const action = useAction();
  const jobs = useQuery({
    queryKey: ['notifications', 'jobs'],
    queryFn: () =>
      api<{ jobs: Job[]; counts: Record<string, number> }>(
        '/notifications/jobs',
      ),
    refetchInterval: 10_000,
  });
  if (jobs.isPending) return <LoadingState />;
  if (jobs.error)
    return (
      <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
    );
  const tone = (status: Job['status']) =>
    status === 'SENT' ? 'success' : status === 'FAILED' ? 'danger' : 'warning';
  return (
    <div className="stack">
      <div className="stat-grid">
        {(['PENDING', 'SENT', 'FAILED'] as const).map((status) => (
          <div key={status} className="stat">
            <small className="muted">{n.status[status]}</small>
            <strong>{jobs.data.counts[status] ?? 0}</strong>
          </div>
        ))}
      </div>
      {jobs.data.jobs.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="ops-list">
          {jobs.data.jobs.map((job) => (
            <li
              key={job.id}
              className={`ops-item ${job.status === 'FAILED' ? 'alarm' : ''}`}
            >
              <div className="grow">
                <strong>
                  {(n.events as Record<string, string>)[job.event] ??
                    n.testEvent}
                </strong>{' '}
                <span className="muted small">
                  {job.recipient ? `→ ${job.recipient} · ` : ''}
                  {formatDateTime(job.createdAt)}
                </span>
                <p className="sop-body small">{job.text}</p>
                {(job.lastError || job.attempts > 0) && (
                  <div
                    className={`small ${job.status === 'FAILED' ? 'danger-text' : 'muted'}`}
                  >
                    {explainError(job.lastError)} · {n.attempts}: {job.attempts}
                  </div>
                )}
              </div>
              <Badge tone={tone(job.status)}>{n.status[job.status]}</Badge>
              {job.status === 'FAILED' && (
                <Button
                  size="sm"
                  onClick={() =>
                    void action(() =>
                      post(`/notifications/jobs/${job.id}/retry`),
                    )
                  }
                >
                  {n.retry}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NotificationsPage() {
  const [tab, setTab] = useState<Tab>('settings');
  const settings = useQuery({
    queryKey: ['notifications', 'settings'],
    queryFn: () => api<Settings>('/notifications/settings'),
  });
  return (
    <>
      <PageHeader title={n.title} subtitle={n.subtitle} />
      <div className="tabs" role="tablist">
        {(Object.keys(n.tabs) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {n.tabs[key]}
          </button>
        ))}
      </div>
      {settings.isPending ? (
        <LoadingState />
      ) : settings.error ? (
        <ErrorState
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          {tab === 'settings' && <SettingsTab settings={settings.data} />}
          {tab === 'subscribers' && <SubscribersTab settings={settings.data} />}
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'delivery' && <DeliveryTab />}
        </>
      )}
    </>
  );
}
