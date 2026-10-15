import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { ownerApi, ownerPost } from '../../lib/owner';

const o = t.owner;

function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await action();
      if (message) toast(message);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

export function OverviewTab() {
  const overview = useQuery({
    queryKey: ['owner', 'overview'],
    queryFn: () =>
      ownerApi<{
        customers: number;
        activeLicenses: number;
        expiringSoon: number;
        devices: Record<'ONLINE' | 'OFFLINE' | 'BLOCKED' | 'NEVER', number>;
        syncConflicts: number;
      }>('/overview'),
    refetchInterval: 30_000,
  });
  if (overview.isPending) return <LoadingState />;
  if (overview.error)
    return (
      <ErrorState
        error={overview.error}
        onRetry={() => void overview.refetch()}
      />
    );
  const data = overview.data;
  const cells: [
    string,
    number,
    'success' | 'warning' | 'danger' | 'neutral',
  ][] = [
    [o.overview.customers, data.customers, 'neutral'],
    [o.overview.licenses, data.activeLicenses, 'success'],
    [
      o.overview.expiring,
      data.expiringSoon,
      data.expiringSoon ? 'warning' : 'neutral',
    ],
    [o.overview.online, data.devices.ONLINE, 'success'],
    [
      o.overview.offline,
      data.devices.OFFLINE,
      data.devices.OFFLINE ? 'warning' : 'neutral',
    ],
    [
      o.overview.blocked,
      data.devices.BLOCKED,
      data.devices.BLOCKED ? 'danger' : 'neutral',
    ],
    [
      o.overview.conflicts,
      data.syncConflicts,
      data.syncConflicts ? 'danger' : 'neutral',
    ],
  ];
  return (
    <div className="stat-grid">
      {cells.map(([label, value, tone]) => (
        <section key={label} className="card stack">
          <span className="muted small">{label}</span>
          <strong style={{ fontSize: '1.8rem' }}>
            <Badge tone={tone}>{value}</Badge>
          </strong>
        </section>
      ))}
    </div>
  );
}

type Release = {
  id: string;
  platform: 'EXE' | 'APK';
  version: string;
  url: string;
  sha256: string;
  notes: string | null;
  stage: 'DRAFT' | 'STAGED' | 'ALL' | 'WITHDRAWN';
  rolloutPercent: number;
  minVersion: string | null;
  installs: number;
  createdAt: string;
};

export function ReleasesTab() {
  const client = useQueryClient();
  const { run, busy } = useAction();
  const [form, setForm] = useState({
    platform: 'EXE',
    version: '',
    url: '',
    sha256: '',
    notes: '',
  });
  const [stage, setStage] = useState<
    Record<string, { stage: string; percent: string; minVersion: string }>
  >({});
  const releases = useQuery({
    queryKey: ['owner', 'releases'],
    queryFn: () =>
      ownerApi<{
        releases: Release[];
        versions: { version: string; count: number }[];
      }>('/releases'),
  });
  const reload = () => client.invalidateQueries({ queryKey: ['owner'] });
  if (releases.isPending) return <LoadingState />;
  if (releases.error)
    return (
      <ErrorState
        error={releases.error}
        onRetry={() => void releases.refetch()}
      />
    );
  const r = o.releases;
  return (
    <div className="stack">
      <p className="muted small">{r.note}</p>
      {releases.data.versions.length > 0 && (
        <p className="small">
          <strong>{r.versions}:</strong>{' '}
          {releases.data.versions
            .map((item) => `${item.version} × ${item.count}`)
            .join(' · ')}
        </p>
      )}
      {releases.data.releases.length === 0 ? (
        <EmptyState title={r.none} />
      ) : (
        <ul className="ops-list">
          {releases.data.releases.map((release) => {
            const draft = stage[release.id] ?? {
              stage: release.stage,
              percent: String(release.rolloutPercent),
              minVersion: release.minVersion ?? '',
            };
            return (
              <li key={release.id} className="ops-item">
                <div className="grow">
                  <strong>
                    {release.platform} {release.version}
                  </strong>{' '}
                  <Badge>{r.stages[release.stage]}</Badge>
                  <div className="muted small">
                    {r.installs}: {release.installs} ·{' '}
                    {formatDateTime(release.createdAt)}
                    {release.stage === 'STAGED'
                      ? ` · ${release.rolloutPercent}%`
                      : ''}
                    {release.minVersion
                      ? ` · ${r.minVersion}: ${release.minVersion}`
                      : ''}
                  </div>
                  <div className="muted small">{release.notes}</div>
                </div>
                <select
                  aria-label={r.stage}
                  value={draft.stage}
                  onChange={(event) =>
                    setStage({
                      ...stage,
                      [release.id]: { ...draft, stage: event.target.value },
                    })
                  }
                >
                  {Object.entries(r.stages).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                {draft.stage === 'STAGED' && (
                  <input
                    aria-label={r.percent}
                    style={{ width: '5rem' }}
                    inputMode="numeric"
                    value={draft.percent}
                    onChange={(event) =>
                      setStage({
                        ...stage,
                        [release.id]: {
                          ...draft,
                          percent: event.target.value.replace(/\D/g, ''),
                        },
                      })
                    }
                  />
                )}
                <input
                  aria-label={r.minVersion}
                  style={{ width: '6rem' }}
                  placeholder="min"
                  value={draft.minVersion}
                  onChange={(event) =>
                    setStage({
                      ...stage,
                      [release.id]: {
                        ...draft,
                        minVersion: event.target.value,
                      },
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ownerPost(`/releases/${release.id}/stage`, {
                        stage: draft.stage,
                        rolloutPercent: Number(draft.percent || '0'),
                        minVersion: /^\d+\.\d+\.\d+$/.test(draft.minVersion)
                          ? draft.minVersion
                          : null,
                      });
                      await reload();
                    })
                  }
                >
                  {r.apply}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <section className="card stack">
        <h3 className="section-title">{r.add}</h3>
        <div className="form-grid">
          <SelectField
            label={r.platform}
            value={form.platform}
            onChange={(event) =>
              setForm({ ...form, platform: event.target.value })
            }
          >
            <option value="EXE">EXE (Windows)</option>
            <option value="APK">APK (Android)</option>
          </SelectField>
          <TextField
            label={r.version}
            placeholder="1.9.0"
            value={form.version}
            onChange={(event) =>
              setForm({ ...form, version: event.target.value })
            }
          />
          <TextField
            label={r.url}
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
          <TextField
            label={r.sha256}
            value={form.sha256}
            onChange={(event) =>
              setForm({ ...form, sha256: event.target.value.toLowerCase() })
            }
          />
          <TextField
            label={r.notes}
            value={form.notes}
            onChange={(event) =>
              setForm({ ...form, notes: event.target.value })
            }
          />
        </div>
        <div>
          <Button
            variant="primary"
            busy={busy}
            disabled={!form.version || !form.url || form.sha256.length !== 64}
            onClick={() =>
              void run(async () => {
                await ownerPost('/releases', {
                  platform: form.platform,
                  version: form.version,
                  url: form.url,
                  sha256: form.sha256,
                  notes: form.notes.trim() || null,
                });
                setForm({
                  ...form,
                  version: '',
                  url: '',
                  sha256: '',
                  notes: '',
                });
                await reload();
              })
            }
          >
            {r.add}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function SecurityTab({ onLogout }: { onLogout: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const { run, busy } = useAction();
  const s = o.security;
  const sessions = useQuery({
    queryKey: ['owner', 'sessions'],
    queryFn: () =>
      ownerApi<{
        sessions: {
          id: string;
          current: boolean;
          device: string;
          ipAddress: string | null;
          createdAt: string;
          lastSeenAt: string;
        }[];
      }>('/owner/sessions'),
  });
  const devices = useQuery({
    queryKey: ['owner', 'ownerDevices'],
    queryFn: () =>
      ownerApi<{
        devices: {
          id: string;
          label: string;
          fingerprint: string;
          status: 'PENDING' | 'APPROVED' | 'REVOKED';
          current: boolean;
          lastSeenAt: string | null;
          lastIp: string | null;
        }[];
      }>('/owner/devices'),
  });
  const reload = () => client.invalidateQueries({ queryKey: ['owner'] });
  return (
    <div className="stack">
      <section className="card stack">
        <h3 className="section-title">{s.devices}</h3>
        <ul className="ops-list">
          {devices.data?.devices.map((device) => (
            <li key={device.id} className="ops-item">
              <div className="grow">
                <strong>{device.label}</strong>{' '}
                {device.current && <Badge tone="accent">{s.current}</Badge>}
                <div className="muted small">
                  {device.fingerprint} · {formatDateTime(device.lastSeenAt)} ·{' '}
                  {device.lastIp ?? '—'}
                </div>
              </div>
              <Badge
                tone={
                  device.status === 'APPROVED'
                    ? 'success'
                    : device.status === 'PENDING'
                      ? 'warning'
                      : 'danger'
                }
              >
                {device.status === 'APPROVED'
                  ? s.approved
                  : device.status === 'PENDING'
                    ? s.pending
                    : s.revoked}
              </Badge>
              {device.status === 'PENDING' && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ownerPost(`/owner/devices/${device.id}/approve`);
                      await reload();
                    })
                  }
                >
                  {s.approve}
                </Button>
              )}
              {device.status !== 'REVOKED' && !device.current && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ownerPost(`/owner/devices/${device.id}/revoke`);
                      await reload();
                    })
                  }
                >
                  {s.revokeDevice}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card stack">
        <h3 className="section-title">{s.sessions}</h3>
        <ul className="ops-list">
          {sessions.data?.sessions.map((session) => (
            <li key={session.id} className="ops-item">
              <div className="grow">
                <strong>{session.device}</strong>{' '}
                {session.current && <Badge tone="accent">{s.current}</Badge>}
                <div className="muted small">
                  {session.ipAddress ?? '—'} ·{' '}
                  {formatDateTime(session.lastSeenAt)}
                </div>
              </div>
              {!session.current && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ownerPost(`/owner/sessions/${session.id}/revoke`);
                      await reload();
                    })
                  }
                >
                  {s.revoke}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div>
          <Button onClick={onLogout}>{o.login.logout}</Button>
        </div>
      </section>
      <section className="card stack">
        <h3 className="section-title">{s.backup}</h3>
        <p className="muted small">{s.backupHint}</p>
        <div>
          <Button
            busy={busy}
            onClick={() =>
              void run(async () => {
                const result = await ownerPost<{
                  ok: boolean;
                  rows: number;
                  tables: number;
                  mismatches: unknown[];
                }>('/backup/verify');
                toast(
                  result.ok
                    ? s.backupOk
                        .replace('{rows}', String(result.rows))
                        .replace('{tables}', String(result.tables))
                    : s.backupFail.replace(
                        '{n}',
                        String(result.mismatches.length),
                      ),
                  result.ok ? 'success' : 'error',
                );
              })
            }
          >
            {s.backupRun}
          </Button>
        </div>
      </section>
    </div>
  );
}

type AuditEntry = {
  id: number;
  action: string;
  outcome: string;
  customerId: string | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  createdAt: string;
  data: unknown;
};

export function AuditTab() {
  const [action, setAction] = useState('');
  const [denied, setDenied] = useState(false);
  const log = useQuery({
    queryKey: ['owner', 'audit', action, denied],
    queryFn: () =>
      ownerApi<{ entries: AuditEntry[] }>(
        `/audit?${new URLSearchParams({
          ...(action ? { action } : {}),
          ...(denied ? { outcome: 'DENIED' } : {}),
        })}`,
      ),
  });
  const a = o.audit;
  return (
    <div className="stack">
      <div className="form-grid">
        <TextField
          label={a.action}
          placeholder={a.filter}
          value={action}
          onChange={(event) => setAction(event.target.value.trim())}
        />
        <Checkbox label={a.onlyDenied} checked={denied} onChange={setDenied} />
      </div>
      {log.isPending ? (
        <LoadingState />
      ) : !log.data || log.data.entries.length === 0 ? (
        <EmptyState title={a.none} />
      ) : (
        <ul className="ops-list">
          {log.data.entries.map((entry) => (
            <li
              key={entry.id}
              className={`ops-item ${entry.outcome !== 'SUCCESS' ? 'alarm' : ''}`}
            >
              <div className="grow">
                <strong>{entry.action}</strong>
                <div className="muted small">
                  {formatDateTime(entry.createdAt)} · {entry.ipAddress ?? '—'}
                  {entry.entityType ? ` · ${entry.entityType}` : ''}
                </div>
              </div>
              <Badge tone={entry.outcome === 'SUCCESS' ? 'success' : 'danger'}>
                {entry.outcome}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
