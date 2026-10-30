import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBranches } from '../components/AppShell';
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
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { shellPanel } from '../lib/shell';
import { appVersion } from '../lib/pwa';
import { api, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

type Device = {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  status: 'ACTIVE' | 'REVOKED' | 'PENDING';
  lastSeenAt: string | null;
  appVersion: string | null;
  createdAt: string;
  panel?: string;
  disabledAt?: string | null;
  allowedUserIds?: string[];
};

type StaffUser = {
  id: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  hasPin: boolean;
};

const d = t.devices;
const panelLabel = (panel: string | undefined) =>
  panel === 'CASHIER'
    ? d.panelCashier
    : panel === 'KITCHEN'
      ? d.panelKitchen
      : panel === 'WAITER'
        ? d.panelWaiter
        : panel === 'DISPLAY'
          ? d.panelDisplay
          : d.panelOther;

/** Name, role and the employees who may sign in on one terminal. */
function TerminalForm({
  device,
  onDone,
}: {
  device: Device;
  onDone: () => void;
}) {
  const { data: me } = useMe();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () =>
      api<{ users: StaffUser[] }>('/users').then((data) => data.users),
    enabled: can(me, 'users.view'),
  });
  const [name, setName] = useState(device.name);
  const [panel, setPanel] = useState(device.panel ?? 'OTHER');
  const [allowed, setAllowed] = useState<string[]>(device.allowedUserIds ?? []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const staff = (users.data ?? []).filter(
    (user) => user.status === 'ACTIVE' && user.hasPin,
  );
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await patch(`/devices/${device.id}`, {
            name,
            ...(device.panel !== 'DISPLAY'
              ? { panel, allowedUserIds: allowed }
              : {}),
          });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={d.deviceName}
        value={name}
        minLength={2}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        required
      />
      {device.panel !== 'DISPLAY' && (
        <SelectField
          label={d.role}
          value={panel}
          onChange={(e) => setPanel(e.target.value)}
        >
          <option value="OTHER">{d.panelOther}</option>
          <option value="CASHIER">{d.panelCashier}</option>
          <option value="WAITER">{d.panelWaiter}</option>
          <option value="KITCHEN">{d.panelKitchen}</option>
        </SelectField>
      )}
      {device.panel !== 'DISPLAY' && (
        <fieldset>
          <legend>{d.employees}</legend>
          <p className="muted small" style={{ marginTop: 0 }}>
            {d.employeesHint}
          </p>
          {users.isPending ? (
            <LoadingState />
          ) : staff.length === 0 ? (
            <p className="notice">{d.noPinUsers}</p>
          ) : (
            <div className="check-grid">
              {staff.map((user) => (
                <Checkbox
                  key={user.id}
                  label={user.displayName}
                  checked={allowed.includes(user.id)}
                  onChange={(on) =>
                    setAllowed((list) =>
                      on
                        ? [...list, user.id]
                        : list.filter((id) => id !== user.id),
                    )
                  }
                />
              ))}
            </div>
          )}
        </fieldset>
      )}
      <p className="muted small">{d.accessNote}</p>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const { data: me } = useMe();
  const branches = useBranches();
  const active = (branches.data ?? []).filter((branch) => branch.isActive);
  const [branchId, setBranchId] = useState(me?.activeBranchId ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/devices/register', {
            branchId: branchId || active[0]?.id,
            name,
            panel: shellPanel(),
          });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">{t.devices.registerHint}</p>
      <SelectField
        label={t.nav.branch}
        value={branchId || active[0]?.id || ''}
        onChange={(e) => setBranchId(e.target.value)}
        required
      >
        {active.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t.devices.deviceName}
        hint={t.devices.deviceNameHint}
        value={name}
        minLength={2}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.devices.register}
        </Button>
      </div>
    </form>
  );
}

export function DevicesPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [registering, setRegistering] = useState(false);
  const [configuring, setConfiguring] = useState<Device | null>(null);
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () =>
      api<{ devices: Device[] }>('/devices').then((data) => data.devices),
    // Connection status stays current while the page is open.
    refetchInterval: 30_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['devices'] });
  const setEnabled = async (device: Device, enabled: boolean) => {
    if (!enabled && !(await confirm(d.disableConfirm))) return;
    try {
      await patch(`/devices/${device.id}`, { enabled });
      toast(enabled ? d.enabledDone : d.disabledDone);
      await refresh();
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
        title={d.terminalsTitle}
        subtitle={d.terminalsSubtitle}
        actions={
          <Button variant="primary" onClick={() => setRegistering(true)}>
            + {t.devices.register}
          </Button>
        }
      />
      {devices.isPending ? (
        <LoadingState />
      ) : devices.error ? (
        <ErrorState
          error={devices.error}
          onRetry={() => void devices.refetch()}
        />
      ) : devices.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th>{d.role}</th>
                <th>{t.nav.branch}</th>
                <th>{t.common.status}</th>
                <th>{t.devices.lastSeen}</th>
                <th>{t.pwa.version}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.name}</strong>
                    {device.status === 'ACTIVE' && device.panel !== 'DISPLAY' && (
                      <small className="muted block">
                        {device.allowedUserIds?.length
                          ? d.employeesCount.replace(
                              '{n}',
                              String(device.allowedUserIds.length),
                            )
                          : d.employeesAll}
                      </small>
                    )}
                  </td>
                  <td>{panelLabel(device.panel)}</td>
                  <td>{device.branchName}</td>
                  <td>
                    {device.status === 'ACTIVE' && device.disabledAt ? (
                      <Badge tone="warning">{d.disabled}</Badge>
                    ) : device.status === 'ACTIVE' ? (
                      <Badge tone="success">{t.common.active}</Badge>
                    ) : device.status === 'PENDING' ? (
                      <Badge tone="warning">{t.devices.pending}</Badge>
                    ) : (
                      <Badge tone="danger">{t.devices.revoked}</Badge>
                    )}
                  </td>
                  <td>
                    {formatDateTime(device.lastSeenAt, t.common.never)}
                    {device.status === 'ACTIVE' && device.lastSeenAt && (
                      <>
                        {' '}
                        <Badge
                          tone={
                            Date.now() - new Date(device.lastSeenAt).getTime() <
                            10 * 60_000
                              ? 'success'
                              : 'neutral'
                          }
                        >
                          {Date.now() - new Date(device.lastSeenAt).getTime() <
                          10 * 60_000
                            ? t.pwa.online
                            : t.pwa.offline}
                        </Badge>
                      </>
                    )}
                  </td>
                  <td className="nowrap">
                    {device.appVersion ?? '—'}{' '}
                    {device.appVersion && device.appVersion !== appVersion && (
                      <Badge tone="warning">{t.pwa.outdated}</Badge>
                    )}
                  </td>
                  <td className="right nowrap">
                    {device.status === 'PENDING' && (
                      <small className="muted">{d.pendingNote}</small>
                    )}
                    {device.status === 'ACTIVE' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => setConfiguring(device)}
                        >
                          {d.configure}
                        </Button>{' '}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void setEnabled(device, !!device.disabledAt)
                          }
                        >
                          {device.disabledAt ? d.enable : d.disable}
                        </Button>{' '}
                      </>
                    )}
                    {device.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!(await confirm(t.devices.revokeConfirm))) return;
                          try {
                            await post(`/devices/${device.id}/revoke`);
                            await refresh();
                          } catch (caught) {
                            toast(
                              caught instanceof Error
                                ? caught.message
                                : t.common.errorTitle,
                              'error',
                            );
                          }
                        }}
                      >
                        {t.devices.revoke}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={registering}
        title={t.devices.register}
        onClose={() => setRegistering(false)}
      >
        {registering && (
          <RegisterForm
            onDone={async () => {
              toast(t.devices.registered);
              setRegistering(false);
              await refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={configuring !== null}
        wide
        title={d.configureTitle}
        onClose={() => setConfiguring(null)}
      >
        {configuring && (
          <TerminalForm
            device={configuring}
            onDone={async () => {
              toast(t.common.saved);
              setConfiguring(null);
              await refresh();
            }}
          />
        )}
      </Dialog>
      {confirmElement}
    </>
  );
}
