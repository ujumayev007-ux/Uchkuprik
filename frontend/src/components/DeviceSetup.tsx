import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { meKey, useMe } from '../auth/session';
import { t } from '../i18n';
import { api, ApiError, post } from '../lib/api';
import { shellPanel } from '../lib/shell';
import { useBranches } from './AppShell';
import { Button, FormError, LoadingState, SelectField, TextField } from './ui';

/** Ends the administrator's password session so the staff PIN pad takes over. */
async function toPinPad(
  client: ReturnType<typeof useQueryClient>,
  navigate: ReturnType<typeof useNavigate>,
) {
  await post('/auth/logout').catch(() => undefined);
  client.setQueryData(meKey, null);
  client.clear();
  navigate('/pin', { replace: true });
}

/**
 * First start of a Kassa, Oshxona or Ofitsiant application: the administrator signs in once
 * with the password and registers the application as this branch's terminal for its panel.
 * Afterwards only staff PIN codes are used, and the server checks each person's role.
 */
export function DeviceSetup() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const branches = useBranches();
  const active = (branches.data ?? []).filter((branch) => branch.isActive);
  const [branchId, setBranchId] = useState(me?.activeBranchId ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const registered = useQuery({
    queryKey: ['pin-device-registered'],
    queryFn: () => api('/pin/device').then(() => true),
    retry: false,
  });
  const missing =
    registered.error instanceof ApiError &&
    registered.error.code === 'DEVICE_REQUIRED';
  // Already registered (approved, or waiting for the Owner): go to the PIN screen.
  const waiting =
    registered.error instanceof ApiError &&
    registered.error.code === 'DEVICE_PENDING';
  useEffect(() => {
    if (registered.isSuccess || waiting) void toPinPad(client, navigate);
  }, [registered.isSuccess, waiting, client, navigate]);
  if (registered.isPending || !missing) return <LoadingState />;
  return (
    <form
      className="stack"
      style={{ maxWidth: '28rem', margin: '4rem auto', padding: '0 1rem' }}
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
          await toPinPad(client, navigate);
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{t.devices.setupTitle}</h1>
      <p className="muted">{t.devices.setupHint}</p>
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
          {t.devices.setupAction}
        </Button>
      </div>
    </form>
  );
}
