import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import {
  Badge,
  Button,
  FormError,
  LoadingState,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

const k = t.control.card;
const dl = t.control.delegated;

type LinkStatus = {
  available: boolean;
  linked: boolean;
  mode: 'ONLINE' | 'OFFLINE' | 'EXPIRED' | 'BLOCKED' | 'UNLINKED';
  reason: string | null;
  customerName: string | null;
  licenseExpiresAt: string | null;
  offlineUntil: string | null;
  offlineEnabled: boolean;
  maxOfflineMinutes: number;
  policyVersion: number;
  lastContactAt: string | null;
  lastError: string | null;
  serverUrl: string | null;
  licenseHint: string | null;
  sync: {
    pending: number;
    conflicts: number;
    failed: number;
    oldestPendingAt: string | null;
  };
  internet?: {
    notificationsQueued: number;
    notificationsFailed: number;
    webhooksQueued: number;
    webhooksFailed: number;
  };
  update: { version: string } | null;
};

export function useControlLink() {
  return useQuery({
    queryKey: ['control-link'],
    queryFn: () => api<LinkStatus>('/control/link/status'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

type Delegated = {
  features: {
    key: string;
    label: string;
    group: string;
    sensitive: boolean;
    defaultEnabled: boolean;
    settings: Record<string, boolean>;
  }[];
  roles: { key: string; name: string }[];
};

function DelegatedFeatures() {
  const toast = useToast();
  const client = useQueryClient();
  const data = useQuery({
    queryKey: ['control-delegated'],
    queryFn: () => api<Delegated>('/control/link/features'),
  });
  if (!data.data) return null;
  const set = async (
    featureKey: string,
    roleKey: string,
    enabled: boolean | null,
  ) => {
    try {
      await api('/control/link/features', {
        method: 'PUT',
        body: { featureKey, roleKey, enabled },
      });
      await client.invalidateQueries();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <section className="card stack">
      <h2 className="section-title">{dl.title}</h2>
      <p className="muted small">{dl.hint}</p>
      {data.data.features.length === 0 && (
        <p className="muted small">{dl.none}</p>
      )}
      {data.data.features.map((feature) => (
        <div key={feature.key} className="stack">
          <strong>
            {feature.label}{' '}
            {feature.sensitive && <Badge tone="warning">₿</Badge>}
          </strong>
          <div className="form-grid">
            {[
              { key: '*', name: dl.all },
              ...data.data.roles.map((role) => ({
                key: role.key ?? '',
                name: role.name,
              })),
            ].map((role) => {
              const value = feature.settings[role.key];
              return (
                <label key={role.key} className="field">
                  <span>
                    {dl.role}: {role.name}
                  </span>
                  <select
                    value={value === undefined ? '' : value ? '1' : '0'}
                    onChange={(event) =>
                      void set(
                        feature.key,
                        role.key,
                        event.target.value === ''
                          ? null
                          : event.target.value === '1',
                      )
                    }
                  >
                    <option value="">{dl.default}</option>
                    <option value="1">{dl.enabled}</option>
                    <option value="0">{dl.disabled}</option>
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

/** Link with the central server: status, activation, sync queue, delegated switches. */
export function ControlLinkCard() {
  const status = useControlLink();
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ licenseKey: '', deviceName: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canManage = me?.permissions.includes('settings.manage');
  if (status.isPending) return <LoadingState />;
  const data = status.data;
  if (!data?.available) return null;
  const tone =
    data.mode === 'ONLINE'
      ? 'success'
      : data.mode === 'OFFLINE'
        ? 'warning'
        : data.mode === 'UNLINKED'
          ? 'neutral'
          : 'danger';
  return (
    <>
      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">{k.title}</h2>
          <Badge tone={tone}>{k.modes[data.mode]}</Badge>
        </div>
        {!data.linked ? (
          <>
            <p className="muted small">{k.notLinked}</p>
            {canManage && (
              <form
                className="stack"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  setError(null);
                  try {
                    await post('/control/link/activate', {
                      licenseKey: form.licenseKey,
                      ...(form.deviceName.trim()
                        ? { deviceName: form.deviceName.trim() }
                        : {}),
                    });
                    toast(k.activated);
                    setForm({ licenseKey: '', deviceName: '' });
                    await client.invalidateQueries();
                  } catch (caught) {
                    setError(caught);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <TextField
                  label={k.licenseKey}
                  placeholder="FFL-XXXXX-XXXXX-XXXXX-XXXXX"
                  autoComplete="off"
                  value={form.licenseKey}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      licenseKey: event.target.value.toUpperCase(),
                    })
                  }
                  required
                />
                <TextField
                  label={k.deviceName}
                  value={form.deviceName}
                  onChange={(event) =>
                    setForm({ ...form, deviceName: event.target.value })
                  }
                />
                <p className="muted small">{k.activateHint}</p>
                <FormError error={error} />
                <div className="form-actions">
                  <Button type="submit" variant="primary" busy={busy}>
                    {k.activate}
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : (
          <>
            <dl className="totals">
              <dt>{k.customer}</dt>
              <dd>{data.customerName}</dd>
              <dt>{k.lastContact}</dt>
              <dd>{formatDateTime(data.lastContactAt)}</dd>
              {data.offlineEnabled && (
                <>
                  <dt>{k.offlineUntil}</dt>
                  <dd>{formatDateTime(data.offlineUntil)}</dd>
                </>
              )}
              <dt>{k.policyVersion}</dt>
              <dd>{data.policyVersion}</dd>
            </dl>
            <p className="muted small">
              {k.queued}: {data.sync.pending} · {k.conflicts}:{' '}
              {data.sync.conflicts} · {k.failed}: {data.sync.failed}
            </p>
            <p className="muted small">{k.queuedNote}</p>
            {data.internet && (
              <p className="muted small">
                {k.internet}: {k.notifications}{' '}
                {data.internet.notificationsQueued} ({k.failed}{' '}
                {data.internet.notificationsFailed}) · {k.webhooks}{' '}
                {data.internet.webhooksQueued} ({k.failed}{' '}
                {data.internet.webhooksFailed})
              </p>
            )}
            {data.update && (
              <p className="small">
                {k.update.replace('{version}', data.update.version)}
              </p>
            )}
            {canManage && (
              <div>
                <Button
                  size="sm"
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await post('/control/link/refresh');
                      await client.invalidateQueries();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {k.refresh}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
      {canManage && data.linked && <DelegatedFeatures />}
    </>
  );
}
