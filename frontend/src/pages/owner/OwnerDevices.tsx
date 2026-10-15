import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import {
  ownerApi,
  ownerPost,
  type DeviceRow,
  type Presence,
} from '../../lib/owner';

const d = t.owner.devices;

const tone = (presence: Presence) =>
  presence === 'ONLINE'
    ? 'success'
    : presence === 'BLOCKED'
      ? 'danger'
      : presence === 'OFFLINE'
        ? 'warning'
        : 'neutral';

export function DeviceCards({
  devices,
  onChange,
}: {
  devices: DeviceRow[];
  onChange: () => void;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await action();
      if (message) toast(message);
      onChange();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  if (devices.length === 0) return <EmptyState title={d.none} />;
  return (
    <div className="stack">
      <p className="muted small">{d.presenceNote}</p>
      {devices.map((device) => {
        const stats = device.stats ?? {};
        return (
          <article key={device.id} className="card stack">
            <div className="toolbar">
              <div className="grow">
                <strong>{device.deviceName}</strong>
                {device.customerName && (
                  <span className="muted"> · {device.customerName}</span>
                )}
                <div className="muted small">
                  {d.branch}: {device.branchName ?? '—'} · {d.model}:{' '}
                  {device.model ?? '—'} · {d.os}: {device.os ?? '—'} ·{' '}
                  {d.version}: {device.appVersion ?? '—'}
                </div>
                <div className="muted small">
                  {d.activated}: {formatDateTime(device.activatedAt)} ·{' '}
                  {d.lastSeen}: {formatDateTime(device.lastHeartbeatAt)} ·{' '}
                  {d.ip}: {device.lastIp ?? '—'} · {d.user}:{' '}
                  {device.currentUser ?? '—'}
                </div>
              </div>
              <Badge tone={tone(device.presence)}>
                {d.presence[device.presence]}
              </Badge>
              <Badge>{d.status[device.status]}</Badge>
            </div>
            {(Number(stats.queued) > 0 ||
              Number(stats.conflicts) > 0 ||
              Number(stats.failed) > 0) && (
              <p className="small">
                {d.queue}: {String(stats.queued ?? 0)} · {d.conflicts}:{' '}
                {String(stats.conflicts ?? 0)} · {d.failed}:{' '}
                {String(stats.failed ?? 0)}
              </p>
            )}
            {device.blockedReason && (
              <p className="muted small">{device.blockedReason}</p>
            )}
            {device.terminals.length > 0 && (
              <details>
                <summary className="small">
                  {d.terminals} ({device.terminals.length})
                </summary>
                <ul className="ops-list">
                  {device.terminals.map((terminal) => (
                    <li key={terminal.id} className="ops-item">
                      <div className="grow">
                        <strong>{terminal.name}</strong>
                        <div className="muted small">
                          {terminal.panel} · {terminal.branchName ?? '—'} ·{' '}
                          {terminal.appVersion ?? '—'} ·{' '}
                          {formatDateTime(terminal.lastSeenAt)} ·{' '}
                          {terminal.lastIp ?? '—'}
                        </div>
                      </div>
                      <Badge tone={tone(terminal.presence)}>
                        {d.presence[terminal.presence]}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="form-actions">
              {device.status === 'ACTIVE' && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => ownerPost(`/devices/${device.id}/block`))
                  }
                >
                  {d.block}
                </Button>
              )}
              {device.status === 'BLOCKED' && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => ownerPost(`/devices/${device.id}/unblock`))
                  }
                >
                  {d.unblock}
                </Button>
              )}
              {device.status !== 'REPLACED' && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm(d.replaceConfirm))
                      void run(() =>
                        ownerPost(`/devices/${device.id}/replace`),
                      );
                  }}
                >
                  {d.replace}
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => ownerPost(`/devices/${device.id}/terminate-sessions`),
                    d.terminated,
                  )
                }
              >
                {d.terminate}
              </Button>
            </div>
          </article>
        );
      })}
      {element}
    </div>
  );
}

export function DevicesTab() {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [presence, setPresence] = useState('');
  const devices = useQuery({
    queryKey: ['owner', 'devices', q, presence],
    queryFn: () =>
      ownerApi<{ devices: DeviceRow[] }>(
        `/devices?${new URLSearchParams({
          ...(q ? { q } : {}),
          ...(presence ? { presence } : {}),
        })}`,
      ),
    refetchInterval: 30_000,
  });
  return (
    <div className="stack">
      <div className="form-grid">
        <TextField
          label={t.common.search}
          placeholder={d.search}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <SelectField
          label={t.common.status}
          value={presence}
          onChange={(event) => setPresence(event.target.value)}
        >
          <option value="">{d.all}</option>
          {(Object.keys(d.presence) as (keyof typeof d.presence)[]).map(
            (key) => (
              <option key={key} value={key}>
                {d.presence[key]}
              </option>
            ),
          )}
        </SelectField>
      </div>
      {devices.isPending ? (
        <LoadingState />
      ) : (
        <DeviceCards
          devices={devices.data?.devices ?? []}
          onChange={() =>
            void client.invalidateQueries({ queryKey: ['owner'] })
          }
        />
      )}
    </div>
  );
}
