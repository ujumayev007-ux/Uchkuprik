import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { meKey, useMe } from '../auth/session';
import { t } from '../i18n';
import { api, ApiError, post } from '../lib/api';
import { shellKind, shellPanel } from '../lib/shell';
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
  // The Queue TV shows the queue with no sign-in; the others use the staff PIN pad.
  navigate(shellKind() === 'tv' ? '/navbat' : '/pin', { replace: true });
}

/**
 * First start of a Kassa, Oshxona or Ofitsiant application: the administrator signs in once
 * with the password and registers the application as this branch's terminal for its panel.
 * Afterwards only staff PIN codes are used, and the server checks each person's role.
 */
export function DeviceSetup({
  afterRegistered,
}: {
  // Shown instead of returning to the PIN pad once this computer is registered and
  // approved (the FastFood application: the administrator keeps working).
  afterRegistered?: ReactNode;
} = {}) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const branches = useBranches();
  const active = (branches.data ?? []).filter((branch) => branch.isActive);
  const [branchId, setBranchId] = useState(me?.activeBranchId ?? '');
  const [name, setName] = useState('');
  // The FastFood application: the administrator decides who may sign in on this computer.
  const universal = shellKind() === 'universal';
  const [panel, setPanel] = useState<'OTHER' | 'CASHIER' | 'KITCHEN' | 'WAITER'>(
    'OTHER',
  );
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
  const keepWorking = !!afterRegistered && registered.isSuccess;
  useEffect(() => {
    if (keepWorking) return;
    if (registered.isSuccess || waiting) void toPinPad(client, navigate);
  }, [keepWorking, registered.isSuccess, waiting, client, navigate]);
  if (keepWorking) return <>{afterRegistered}</>;
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
            panel: universal ? panel : shellPanel(),
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
      {universal && (
        <SelectField
          label={t.devices.panelLabel}
          hint={t.devices.panelHint}
          value={panel}
          onChange={(e) => setPanel(e.target.value as typeof panel)}
        >
          <option value="OTHER">{t.devices.panelAll}</option>
          <option value="CASHIER">{t.devices.panelCashier}</option>
          <option value="KITCHEN">{t.devices.panelKitchen}</option>
          <option value="WAITER">{t.devices.panelWaiter}</option>
        </SelectField>
      )}
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.devices.setupAction}
        </Button>
      </div>
    </form>
  );
}
