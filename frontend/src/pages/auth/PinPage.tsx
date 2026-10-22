import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { meKey } from '../../auth/session';
import { ErrorState, LoadingState } from '../../components/ui';
import { t } from '../../i18n';
import { isPanelShell } from '../../lib/shell';
import { api, ApiError, errorMessage, post } from '../../lib/api';
import { AuthLayout } from './AuthLayout';
import { LiveClock } from '../../components/LiveClock';

type DeviceInfo = {
  device: { id: string; name: string };
  tenant: { name: string };
  branch: { id: string; name: string };
  staff: { id: string; displayName: string }[];
};

const KEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'clear',
  '0',
  'erase',
] as const;

export function PinPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const device = useQuery({
    queryKey: ['pin-device'],
    queryFn: () => api<DeviceInfo>('/pin/device'),
    retry: false,
    // Waiting for the Owner: look again by itself until the device is approved.
    refetchInterval: (query) =>
      query.state.error instanceof ApiError &&
      query.state.error.code === 'DEVICE_PENDING'
        ? 10_000
        : false,
  });
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await post('/auth/pin', { userId, pin: value });
      // Drop the cached 'signed out' answer so the next screen asks the server again.
      client.removeQueries({ queryKey: meKey });
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (key: (typeof KEYS)[number]) => {
    if (busy) return;
    if (key === 'clear') return setPin('');
    if (key === 'erase') return setPin((value) => value.slice(0, -1));
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) void submit(next);
  };

  // Physical keyboards and numeric pads work as well as the touchscreen keypad.
  useEffect(() => {
    if (!userId) return;
    const handler = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) press(event.key as (typeof KEYS)[number]);
      else if (event.key === 'Backspace') press('erase');
      else if (event.key === 'Escape') setUserId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  if (device.isPending)
    return (
      <AuthLayout title={t.pin.title}>
        <LoadingState />
      </AuthLayout>
    );
  if (device.error) {
    const unregistered =
      device.error instanceof ApiError &&
      device.error.code === 'DEVICE_REQUIRED';
    const pending =
      device.error instanceof ApiError &&
      device.error.code === 'DEVICE_PENDING';
    return (
      <AuthLayout
        title={
          pending
            ? t.pin.pendingTitle
            : unregistered
              ? t.pin.noDevice
              : t.common.errorTitle
        }
        subtitle={
          pending
            ? t.pin.pendingHint
            : unregistered
              ? t.pin.noDeviceHint
              : undefined
        }
      >
        {!unregistered && !pending && (
          <ErrorState
            error={device.error}
            onRetry={() => void device.refetch()}
          />
        )}
        <Link className="btn btn-primary btn-lg" to="/kirish">
          {isPanelShell() ? t.pin.adminSetup : t.pin.passwordLogin}
        </Link>
      </AuthLayout>
    );
  }

  const info = device.data;
  const selected = info.staff.find((member) => member.id === userId);

  return (
    <AuthLayout
      title={selected ? selected.displayName : t.pin.title}
      subtitle={`${info.tenant.name} · ${info.branch.name} · ${info.device.name}`}
      wide
    >
      <div className="center">
        <LiveClock large />
      </div>
      {!selected ? (
        info.staff.length === 0 ? (
          <p className="muted center">{t.pin.noStaff}</p>
        ) : (
          <div className="staff-grid">
            {info.staff.map((member) => (
              <button
                key={member.id}
                className="staff-tile"
                onClick={() => {
                  setUserId(member.id);
                  setPin('');
                  setError(null);
                }}
              >
                <span className="avatar avatar-lg" aria-hidden="true">
                  {member.displayName.slice(0, 1).toUpperCase()}
                </span>
                {member.displayName}
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="pin-pad">
          <p className="muted center">{t.pin.enterPin}</p>
          <div className="pin-dots" aria-label={t.pin.enterPin} role="status">
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                className={index < pin.length ? 'filled' : ''}
              />
            ))}
          </div>
          {error && (
            <p className="form-error center" role="alert">
              {error}
            </p>
          )}
          <div className="keypad">
            {KEYS.map((key) => (
              <button
                key={key}
                className={`key ${key.length > 1 ? 'key-action' : ''}`}
                onClick={() => press(key)}
                disabled={busy}
                aria-label={
                  key === 'clear'
                    ? t.pin.clear
                    : key === 'erase'
                      ? t.pin.erase
                      : key
                }
              >
                {key === 'clear' ? 'C' : key === 'erase' ? '⌫' : key}
              </button>
            ))}
          </div>
          <button className="text-link center" onClick={() => setUserId(null)}>
            {t.pin.changeUser}
          </button>
        </div>
      )}
      <Link className="text-link center" to="/kirish">
        {isPanelShell() ? t.pin.adminSetup : t.pin.passwordLogin}
      </Link>
    </AuthLayout>
  );
}
