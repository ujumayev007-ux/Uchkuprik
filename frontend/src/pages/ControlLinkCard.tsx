import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ParamFields } from '../components/ParamFields';
import type { ParamDef, ParamValue } from '../lib/owner';
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
    params: ParamDef[];
    values: Record<string, Record<string, ParamValue>>;
    ownerValues: Record<string, ParamValue>;
  }[];
  roles: { key: string; name: string }[];
};

/** Values (limits, default modes) the Admin chooses for one delegated feature and role. */
function DelegatedValues({
  feature,
  roleKey,
  roleName,
  onSave,
}: {
  feature: Delegated['features'][number];
  roleKey: string;
  roleName: string;
  onSave: (params: Record<string, ParamValue> | null) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, ParamValue>>(
    feature.values[roleKey] ?? {},
  );
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack compact">
      <span className="field-label">
        {dl.values}: {roleName}
      </span>
      <ParamFields
        defs={feature.params}
        values={values}
        inherited={feature.ownerValues}
        caps={feature.ownerValues}
        onChange={(key, value) =>
          setValues((current) => {
            const next = { ...current };
            if (value === undefined) delete next[key];
            else next[key] = value;
            return next;
          })
        }
      />
      <div>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(Object.keys(values).length ? values : null);
            } finally {
              setBusy(false);
            }
          }}
        >
          {dl.saveValues}
        </Button>
      </div>
    </div>
  );
}

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
    change:
      | { enabled: boolean | null }
      | { params: Record<string, ParamValue> | null },
  ) => {
    try {
      await api('/control/link/features', {
        method: 'PUT',
        body: { featureKey, roleKey, ...change },
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
                      void set(feature.key, role.key, {
                        enabled:
                          event.target.value === ''
                            ? null
                            : event.target.value === '1',
                      })
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
          {feature.params.length > 0 &&
            [
              { key: '*', name: dl.all },
              ...data.data.roles.map((role) => ({
                key: role.key ?? '',
                name: role.name,
              })),
            ].map((role) => (
              <DelegatedValues
                key={`${feature.key}|${role.key}`}
                feature={feature}
                roleKey={role.key}
                roleName={role.name}
                onSave={(params) => set(feature.key, role.key, { params })}
              />
            ))}
        </div>
      ))}
    </section>
  );
}

/** Address of the central server; changed after a server migration (verified first). */
function ServerAddress({
  current,
  canManage,
}: {
  current: string | null;
  canManage: boolean;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <details className="stack compact">
      <summary className="muted small">{k.serverAdvanced}</summary>
      <div className="muted small">
        {k.server}: <strong>{current ?? '—'}</strong>
      </div>
      {canManage && (
        <form
          className="stack compact"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api('/control/link/server', {
                method: 'PUT',
                body: { url: value.trim() },
              });
              toast(k.serverSaved);
              setValue('');
              await client.invalidateQueries();
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label={k.serverChange}
            placeholder="https://server.misol.uz"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="muted small">{k.serverHint}</p>
          <FormError error={error} />
          <div className="form-actions">
            <Button type="submit" busy={busy} disabled={!value.trim()}>
              {k.serverChange}
            </Button>
          </div>
        </form>
      )}
    </details>
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
            <ServerAddress current={data.serverUrl} canManage={!!canManage} />
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
