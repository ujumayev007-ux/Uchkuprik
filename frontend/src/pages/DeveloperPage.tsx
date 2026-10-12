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
  PageHeader,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const d = t.developer;
type Scope = keyof typeof d.scopes;
type WebhookEvent = keyof typeof d.webhookEvents;

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
type Endpoint = {
  id: string;
  url: string;
  events: WebhookEvent[];
  isActive: boolean;
};
type Delivery = {
  id: string;
  event: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  createdAt: string;
};

function SecretDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={value !== null} title={title} onClose={onClose}>
      <p>{d.copyOnce}</p>
      <p className="secret-box">{value}</p>
    </Dialog>
  );
}

function KeysSection() {
  const toast = useToast();
  const client = useQueryClient();
  const { confirm, element } = useConfirm();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['orders.read']);
  const [secret, setSecret] = useState<string | null>(null);
  const keys = useQuery({
    queryKey: ['developer', 'keys'],
    queryFn: () =>
      api<{ keys: ApiKey[]; scopes: Scope[] }>('/developer/api-keys'),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['developer'] });
  return (
    <section className="card stack">
      <h2 className="section-title">{d.keys}</h2>
      <p className="muted small">{d.keysHint}</p>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const created = await post<{ key: string }>('/developer/api-keys', {
              name,
              scopes,
            });
            setSecret(created.key);
            setName('');
            await refresh();
          } catch (caught) {
            toast(errorMessage(caught), 'error');
          }
        }}
      >
        <TextField
          label={d.keyName}
          value={name}
          minLength={2}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <div className="check-grid">
          {(Object.keys(d.scopes) as Scope[]).map((key) => (
            <Checkbox
              key={key}
              label={d.scopes[key]}
              checked={scopes.includes(key)}
              onChange={(on) =>
                setScopes(
                  on ? [...scopes, key] : scopes.filter((s) => s !== key),
                )
              }
            />
          ))}
        </div>
        <div className="form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={scopes.length === 0}
          >
            + {d.createKey}
          </Button>
        </div>
      </form>
      {keys.isPending ? (
        <LoadingState />
      ) : keys.error ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.keys.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="ops-list">
          {keys.data.keys.map((key) => (
            <li key={key.id} className="ops-item">
              <div className="grow">
                <strong>{key.name}</strong> <code>{key.prefix}…</code>
                <div className="muted small">
                  {key.scopes.map((scope) => d.scopes[scope]).join(', ')} ·{' '}
                  {d.lastUsed}: {formatDateTime(key.lastUsedAt)}
                </div>
              </div>
              {key.revokedAt ? (
                <Badge tone="danger">{d.revoked}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (!(await confirm(d.revokeConfirm))) return;
                    try {
                      await post(`/developer/api-keys/${key.id}/revoke`);
                      await refresh();
                    } catch (caught) {
                      toast(errorMessage(caught), 'error');
                    }
                  }}
                >
                  {d.revoke}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <SecretDialog
        title={d.newKey}
        value={secret}
        onClose={() => setSecret(null)}
      />
      {element}
    </section>
  );
}

function Deliveries({ endpointId }: { endpointId: string }) {
  const toast = useToast();
  const deliveries = useQuery({
    queryKey: ['developer', 'deliveries', endpointId],
    queryFn: () =>
      api<{ deliveries: Delivery[] }>(
        `/developer/webhooks/${endpointId}/deliveries`,
      ).then((data) => data.deliveries),
    refetchInterval: 10_000,
  });
  if (!deliveries.data) return <LoadingState />;
  if (deliveries.data.length === 0) return <p className="muted small">—</p>;
  return (
    <ul className="ops-list">
      {deliveries.data.map((row) => (
        <li
          key={row.id}
          className={`ops-item ${row.status === 'FAILED' ? 'alarm' : ''}`}
        >
          <div className="grow">
            <strong>{row.event}</strong>{' '}
            <span className="muted small">{formatDateTime(row.createdAt)}</span>
            {row.lastError && (
              <div className="muted small">
                {row.lastError} · {d.attempts}: {row.attempts}
              </div>
            )}
          </div>
          <Badge
            tone={
              row.status === 'SENT'
                ? 'success'
                : row.status === 'FAILED'
                  ? 'danger'
                  : 'warning'
            }
          >
            {d.deliveryStatus[row.status]}
          </Badge>
          {row.status === 'FAILED' && (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await post(`/developer/deliveries/${row.id}/retry`);
                  await deliveries.refetch();
                } catch (caught) {
                  toast(errorMessage(caught), 'error');
                }
              }}
            >
              {d.retry}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function WebhooksSection() {
  const toast = useToast();
  const client = useQueryClient();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['order.completed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const endpoints = useQuery({
    queryKey: ['developer', 'webhooks'],
    queryFn: () =>
      api<{ endpoints: Endpoint[]; events: WebhookEvent[] }>(
        '/developer/webhooks',
      ),
  });
  return (
    <section className="card stack">
      <h2 className="section-title">{d.webhooks}</h2>
      <p className="muted small">{d.webhooksHint}</p>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const created = await post<{ secret: string }>(
              '/developer/webhooks',
              {
                url,
                events,
              },
            );
            setSecret(created.secret);
            setUrl('');
            await client.invalidateQueries({ queryKey: ['developer'] });
          } catch (caught) {
            toast(errorMessage(caught), 'error');
          }
        }}
      >
        <TextField
          label={d.url}
          type="url"
          pattern="https://.*"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <div className="check-grid">
          {(Object.keys(d.webhookEvents) as WebhookEvent[]).map((key) => (
            <Checkbox
              key={key}
              label={d.webhookEvents[key]}
              checked={events.includes(key)}
              onChange={(on) =>
                setEvents(
                  on ? [...events, key] : events.filter((e) => e !== key),
                )
              }
            />
          ))}
        </div>
        <div className="form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={events.length === 0}
          >
            + {d.addWebhook}
          </Button>
        </div>
      </form>
      {endpoints.data?.endpoints.length === 0 && <EmptyState />}
      <ul className="ops-list">
        {(endpoints.data?.endpoints ?? []).map((row) => (
          <li key={row.id} className="ops-item">
            <div className="grow">
              <strong>{row.url}</strong>
              <div className="muted small">
                {row.events.map((key) => d.webhookEvents[key]).join(', ')}
              </div>
              {open === row.id && <Deliveries endpointId={row.id} />}
            </div>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await post(`/developer/webhooks/${row.id}/test`);
                  toast(d.pingQueued);
                  setOpen(row.id);
                } catch (caught) {
                  toast(errorMessage(caught), 'error');
                }
              }}
            >
              {d.ping}
            </Button>
            <Button
              size="sm"
              onClick={() => setOpen(open === row.id ? null : row.id)}
            >
              {d.log}
            </Button>
          </li>
        ))}
      </ul>
      <SecretDialog
        title={d.signingSecret}
        value={secret}
        onClose={() => setSecret(null)}
      />
    </section>
  );
}

export function DeveloperPage() {
  return (
    <div className="stack">
      <PageHeader title={d.title} subtitle={d.subtitle} />
      <section className="card stack">
        <h2 className="section-title">{d.docs}</h2>
        <p className="sop-body small">{d.docsBody}</p>
      </section>
      <KeysSection />
      <WebhooksSection />
    </div>
  );
}
