import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  ordersEnabled?: boolean;
  receiptsEnabled?: boolean;
  orderBranchId?: string | null;
  webhookUrl: string;
  events: EventKey[];
};
type Subscriber = {
  id: string;
  name: string;
  chatId: string | null;
  linkCode: string | null;
  events: EventKey[];
  branchIds: string[];
  isActive: boolean;
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
};

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
          ? `${n.connected}: @${settings.botUsername ?? '—'}`
          : n.notConfigured}
      </p>
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
            {String(value).padStart(2, '0')}:00
          </option>
        ))}
      </SelectField>
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
  onDone: (linkCode: string | null) => void;
}) {
  const branches = useBranches();
  const [form, setForm] = useState({
    name: subscriber?.name ?? '',
    chatId: subscriber?.chatId ?? '',
    events: subscriber?.events ?? events,
    branchIds: subscriber?.branchIds ?? [],
    isActive: subscriber?.isActive ?? true,
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
            const created = await post<{ linkCode: string | null }>(
              '/notifications/subscribers',
              body,
            );
            onDone(created.linkCode);
          }
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          minLength={2}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          required
        />
        <TextField
          label={`${n.chatId} (${t.common.optional})`}
          hint={n.chatIdHint}
          inputMode="numeric"
          pattern="-?\d{1,20}"
          value={form.chatId}
          onChange={(event) => setForm({ ...form, chatId: event.target.value })}
        />
      </div>
      <fieldset>
        <legend>{n.eventsTitle}</legend>
        <div className="check-grid">
          {events.map((key) => (
            <Checkbox
              key={key}
              label={n.events[key]}
              checked={form.events.includes(key)}
              onChange={(on) =>
                setForm({ ...form, events: toggle(form.events, key, on) })
              }
            />
          ))}
        </div>
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
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
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
  const [code, setCode] = useState<string | null>(null);
  const subscribers = useQuery({
    queryKey: ['notifications', 'subscribers'],
    queryFn: () =>
      api<{ subscribers: Subscriber[] }>('/notifications/subscribers').then(
        (data) => data.subscribers,
      ),
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {n.addSubscriber}
        </Button>
      </div>
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
                <strong>{row.name}</strong>
                <div className="muted small">
                  {row.events.map((key) => n.events[key]).join(', ') || '—'}
                </div>
                {row.linkCode && (
                  <div className="small">
                    {n.linkWith}: <code>/start {row.linkCode}</code>
                    {settings.botUsername && ` → @${settings.botUsername}`}
                  </div>
                )}
              </div>
              <Badge tone={row.chatId ? 'success' : 'warning'}>
                {row.chatId ? n.linked : n.notLinked}
              </Badge>
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
            onDone={(linkCode) => {
              setEditing(null);
              setCode(linkCode);
              void client.invalidateQueries({ queryKey: ['notifications'] });
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={code !== null}
        title={n.linkTitle}
        onClose={() => setCode(null)}
      >
        <p>{n.linkInstructions}</p>
        <p className="secret-box">/start {code}</p>
      </Dialog>
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
                  {formatDateTime(job.createdAt)}
                </span>
                <p className="sop-body small">{job.text}</p>
                {job.lastError && (
                  <div className="muted small">
                    {job.lastError} · {n.attempts}: {job.attempts}
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
