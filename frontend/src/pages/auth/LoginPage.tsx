import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { meKey } from '../../auth/session';
import { Button, FormError, TextField } from '../../components/ui';
import { t } from '../../i18n';
import { api, post } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

const TENANT_KEY = 'ff-last-tenant';

function rememberedTenant() {
  try {
    return localStorage.getItem(TENANT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** The Kassa, Ofitsiant, Oshxona and TV applications go straight to the PIN keypad once this device is registered. */
function usesPinShell() {
  const shell = (window as unknown as { fastfoodShell?: { kind?: string } })
    .fastfoodShell;
  return (
    shell?.kind === 'cashier' ||
    shell?.kind === 'waiter' ||
    shell?.kind === 'kitchen' ||
    shell?.kind === 'tv'
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const pinDevice = useQuery({
    queryKey: ['pin-device'],
    queryFn: () => api('/pin/device'),
    enabled: usesPinShell(),
    retry: false,
  });
  useEffect(() => {
    if (usesPinShell() && pinDevice.data) navigate('/pin', { replace: true });
  }, [pinDevice.data, navigate]);
  const [tenant, setTenant] = useState(rememberedTenant);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthLayout title={t.auth.title} subtitle={t.auth.subtitle} tenant={tenant}>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/auth/login', { tenant, username, password });
            try {
              localStorage.setItem(TENANT_KEY, tenant.trim().toLowerCase());
            } catch {
              /* Remembering the business code is a convenience only. */
            }
            await client.invalidateQueries({ queryKey: meKey });
            navigate('/', { replace: true });
          } catch (caught) {
            setError(caught);
            setPassword('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label={t.auth.tenant}
          hint={t.auth.tenantHint}
          autoComplete="organization"
          autoCapitalize="none"
          spellCheck={false}
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          required
        />
        <TextField
          label={t.auth.username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          autoFocus={!!tenant}
        />
        <TextField
          label={t.auth.password}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <FormError error={error} />
        <Button type="submit" variant="primary" size="lg" busy={busy}>
          {t.auth.submit}
        </Button>
        <Link className="text-link center" to="/pin">
          {t.auth.pinLogin}
        </Link>
        <Link className="text-link center" to="/royxatdan-otish">
          {t.register.noAccount}
        </Link>
      </form>
    </AuthLayout>
  );
}
