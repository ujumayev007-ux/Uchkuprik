import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
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
  ownerPatch,
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
      : presence === 'PENDING'
        ? 'warning'
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
  // "Qurilma nomini o‘zgartirish" / "Windows nomini o‘zgartirish".
  const [naming, setNaming] = useState<{
    device: DeviceRow;
    kind: 'display' | 'host';
    value: string;
  } | null>(null);
  const run = async (action: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await action();
      if (message) toast(message);
      onChange();
      return true;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const confirmed = async (
    message: string,
    action: () => Promise<unknown>,
    done?: string,
  ) => {
    if (await confirm(message)) await run(action, done);
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
                <strong>{device.displayName || device.deviceName}</strong>
                {device.customerName && (
                  <span className="muted"> · {device.customerName}</span>
                )}
                <div className="muted small">
                  {d.branch}: {device.branchName ?? '—'} · {d.model}:{' '}
                  {device.model ?? '—'} · {d.os}: {device.os ?? '—'} ·{' '}
                  {d.version}: {device.appVersion ?? '—'}
                </div>
                <div className="muted small">
                  {d.hostname}: {device.hostname ?? '—'} · {d.deviceId}:{' '}
                  <code>{device.deviceId ?? '—'}</code>
                  {device.installId && (
                    <>
                      {' '}
                      · {d.installId}: <code>{device.installId}</code>
                    </>
                  )}
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
            {device.hostRename && (
              <p className="small">
                <Badge
                  tone={
                    device.hostRename.status === 'DONE'
                      ? 'success'
                      : device.hostRename.status === 'REQUESTED'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {d.hostRenameState[device.hostRename.status].replace(
                    '{name}',
                    device.hostRename.name,
                  )}
                </Badge>
              </p>
            )}
            {device.terminals.some((x) => x.status === 'PENDING') && (
              <p className="small">
                <Badge tone="warning">
                  {d.terminalsPending.replace(
                    '{n}',
                    String(
                      device.terminals.filter((x) => x.status === 'PENDING')
                        .length,
                    ),
                  )}
                </Badge>
              </p>
            )}
            {device.terminals.length > 0 && (
              <details
                open={device.terminals.some((x) => x.status === 'PENDING')}
              >
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
                      {terminal.status === 'PENDING' && (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  ownerPost(
                                    `/devices/${device.id}/terminals/${terminal.localId}/approve`,
                                  ),
                                d.terminalApproved,
                              )
                            }
                          >
                            {d.terminalApprove}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={async () => {
                              if (!(await confirm(d.terminalRejectConfirm)))
                                return;
                              void run(
                                () =>
                                  ownerPost(
                                    `/devices/${device.id}/terminals/${terminal.localId}/reject`,
                                  ),
                                d.terminalRejected,
                              );
                            }}
                          >
                            {d.terminalReject}
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="form-actions">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  setNaming({
                    device,
                    kind: 'display',
                    value: device.displayName ?? '',
                  })
                }
              >
                {d.rename}
              </Button>
              {device.status === 'ACTIVE' && (
                <Button
                  size="sm"
                  disabled={
                    busy || !device.capabilities?.includes('rename_host')
                  }
                  title={
                    device.capabilities?.includes('rename_host')
                      ? undefined
                      : d.agentMissing
                  }
                  onClick={() =>
                    setNaming({
                      device,
                      kind: 'host',
                      value: device.hostname ?? '',
                    })
                  }
                >
                  {d.hostRename}
                </Button>
              )}
              {device.status === 'PENDING' && (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => ownerPost(`/devices/${device.id}/approve`),
                        d.approved,
                      )
                    }
                  >
                    {d.approve}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void confirmed(
                        d.rejectConfirm,
                        () => ownerPost(`/devices/${device.id}/reject`),
                        d.rejected,
                      )
                    }
                  >
                    {d.reject}
                  </Button>
                </>
              )}
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
              {(device.status === 'ACTIVE' || device.status === 'BLOCKED') && (
                <Button
                  size="sm"
                  disabled={busy || !device.capabilities?.includes('rekey')}
                  title={
                    device.capabilities?.includes('rekey')
                      ? undefined
                      : d.agentMissing
                  }
                  onClick={() =>
                    void confirmed(
                      d.resetIdConfirm,
                      () => ownerPost(`/devices/${device.id}/reset-id`),
                      d.resetIdSent,
                    )
                  }
                >
                  {d.resetId}
                </Button>
              )}
              {(device.status === 'ACTIVE' || device.status === 'BLOCKED') && (
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
              {(device.status === 'REPLACED' || device.status === 'REVOKED') &&
                !device.archivedAt && (
                  <>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void confirmed(
                          d.reconnectConfirm,
                          () => ownerPost(`/devices/${device.id}/reconnect`),
                          d.reconnected,
                        )
                      }
                    >
                      {d.reconnect}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void confirmed(
                          d.archiveConfirm,
                          () => ownerPost(`/devices/${device.id}/archive`),
                          d.archived,
                        )
                      }
                    >
                      {d.archive}
                    </Button>
                  </>
                )}
              {(device.status === 'ACTIVE' || device.status === 'BLOCKED') && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        ownerPost(`/devices/${device.id}/terminate-sessions`),
                      d.terminated,
                    )
                  }
                >
                  {d.terminate}
                </Button>
              )}
              {(device.status === 'ACTIVE' || device.status === 'BLOCKED') &&
                !(
                  device.capabilities?.includes('rekey') &&
                  device.capabilities.includes('rename_host')
                ) && <p className="muted small">{d.agentMissing}</p>}
            </div>
          </article>
        );
      })}
      {naming && (
        <Dialog
          open
          title={naming.kind === 'display' ? d.renameTitle : d.hostRenameTitle}
          description={
            naming.kind === 'display' ? d.renameHint : d.hostRenameHint
          }
          onClose={() => setNaming(null)}
          footer={
            <>
              <Button onClick={() => setNaming(null)}>{t.common.cancel}</Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={naming.kind === 'host' && !naming.value.trim()}
                onClick={async () => {
                  const target = naming;
                  const ok = await run(
                    () =>
                      target.kind === 'display'
                        ? ownerPatch(`/devices/${target.device.id}`, {
                            displayName: target.value.trim() || null,
                          })
                        : ownerPost(
                            `/devices/${target.device.id}/rename-host`,
                            {
                              name: target.value.trim(),
                            },
                          ),
                    target.kind === 'display' ? d.renamed : d.hostRenameSent,
                  );
                  if (ok) setNaming(null);
                }}
              >
                {t.common.save}
              </Button>
            </>
          }
        >
          <TextField
            label={
              naming.kind === 'display' ? d.renameTitle : d.hostRenameTitle
            }
            value={naming.value}
            maxLength={naming.kind === 'display' ? 80 : 15}
            placeholder={naming.device.hostname ?? naming.device.deviceName}
            onChange={(event) =>
              setNaming({ ...naming, value: event.target.value })
            }
            autoFocus
          />
        </Dialog>
      )}
      {element}
    </div>
  );
}

export function DevicesTab() {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [presence, setPresence] = useState('');
  const [archived, setArchived] = useState(false);
  const devices = useQuery({
    queryKey: ['owner', 'devices', q, presence, archived],
    queryFn: () =>
      ownerApi<{ devices: DeviceRow[] }>(
        `/devices?${new URLSearchParams({
          ...(q ? { q } : {}),
          ...(presence ? { presence } : {}),
          ...(archived ? { archived: 'true' } : {}),
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
      <Checkbox
        label={d.showArchived}
        checked={archived}
        onChange={setArchived}
      />
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
