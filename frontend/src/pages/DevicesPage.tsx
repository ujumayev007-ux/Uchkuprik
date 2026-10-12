import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import { useBranches } from '../components/AppShell';
import {
  Badge,
  Button,
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
import { appVersion } from '../lib/pwa';
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

type Device = {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
  status: 'ACTIVE' | 'REVOKED';
  lastSeenAt: string | null;
  appVersion: string | null;
  createdAt: string;
};

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
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () =>
      api<{ devices: Device[] }>('/devices').then((data) => data.devices),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['devices'] });
  return (
    <>
      <PageHeader
        title={t.devices.title}
        subtitle={t.devices.subtitle}
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
                  </td>
                  <td>{device.branchName}</td>
                  <td>
                    {device.status === 'ACTIVE' ? (
                      <Badge tone="success">{t.common.active}</Badge>
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
                  <td className="right">
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
      {confirmElement}
    </>
  );
}
