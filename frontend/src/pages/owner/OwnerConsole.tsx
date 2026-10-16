import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';
import { ApiError, api, post } from '../../lib/api';
import {
  ownerApi,
  ownerBridge,
  setOwnerReauthPrompt,
  type FeatureDef,
} from '../../lib/owner';
import { AdsTab } from './OwnerAds';
import { CustomersTab } from './OwnerCustomers';
import { DesignTab } from './OwnerDesign';
import { DevicesTab } from './OwnerDevices';
import { AuditTab, OverviewTab, ReleasesTab, SecurityTab } from './OwnerMisc';

const o = t.owner;

type OwnerMe = { email: string; displayName: string; mfaVerified: boolean };

/** Is this server the central control plane? (the Owner console only exists there) */
export function useControlPlane() {
  return useQuery({
    queryKey: ['control', 'info'],
    queryFn: async () => {
      try {
        return await api<{ plane: boolean }>('/control/info');
      } catch {
        return { plane: false };
      }
    },
    staleTime: 5 * 60_000,
  });
}

function OwnerLogin({ onDone }: { onDone: () => void }) {
  const bridge = ownerBridge();
  const [form, setForm] = useState({ email: '', password: '', code: '' });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Remember on this computer": the saved key makes the code field unnecessary.
  const [saved, setSaved] = useState(false);
  const [keyText, setKeyText] = useState('');
  useEffect(() => {
    void bridge?.rememberGet?.().then((info) => {
      setSaved(info.hasKey);
      if (info.email) setForm((current) => ({ ...current, email: info.email }));
    });
  }, [bridge]);
  if (!bridge) return <ErrorState error={new Error(o.login.noBridge)} />;
  return (
    <form
      className="card stack"
      style={{ maxWidth: '28rem', margin: '2rem auto' }}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const email = form.email.trim().toLowerCase();
          const key = await bridge.deviceKey();
          const { challenge } = await post<{ challenge: string }>(
            '/control/owner/challenge',
          );
          const deviceSignature = await bridge.sign({ challenge, email });
          const code =
            saved && bridge.code ? (await bridge.code()).code : form.code;
          await post('/control/owner/login', {
            email,
            password: form.password,
            challenge,
            deviceKey: key.publicKey,
            deviceSignature,
            deviceLabel: key.label,
            code,
          });
          // Keep the key on this computer only when the owner asked for it.
          if (!saved && keyText.trim() && bridge.rememberSet)
            await bridge
              .rememberSet({ email, secret: keyText.trim() })
              .catch(() => undefined);
          setForm({ email: '', password: '', code: '' });
          onDone();
        } catch (caught) {
          if (caught instanceof ApiError && caught.code === 'DEVICE_PENDING')
            setNotice(o.login.pending.replace('{fingerprint}', ''));
          else setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{o.login.title}</h1>
      <TextField
        label={o.login.email}
        type="email"
        autoComplete="username"
        value={form.email}
        onChange={(event) => setForm({ ...form, email: event.target.value })}
        required
      />
      <TextField
        label={o.login.password}
        type="password"
        autoComplete="current-password"
        value={form.password}
        onChange={(event) => setForm({ ...form, password: event.target.value })}
        required
      />
      {saved ? (
        <p className="muted small">
          {o.login.remembered}{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await bridge.rememberClear?.();
              setSaved(false);
            }}
          >
            {o.login.forget}
          </button>
        </p>
      ) : (
        <>
          <TextField
            label={o.login.code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={form.code}
            onChange={(event) =>
              setForm({ ...form, code: event.target.value.replace(/\D/g, '') })
            }
            required
          />
          {bridge.rememberSet && (
            <TextField
              label={o.login.keyLabel}
              hint={o.login.keyHint}
              autoComplete="off"
              value={keyText}
              onChange={(event) => setKeyText(event.target.value)}
            />
          )}
        </>
      )}
      {notice && <p className="muted small">{notice}</p>}
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {o.login.submit}
        </Button>
      </div>
    </form>
  );
}

/** Step-up dialog: password + fresh code, then the failed action is retried. */
function ReauthHost() {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [form, setForm] = useState({ password: '', code: '' });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void ownerBridge()
      ?.rememberGet?.()
      .then((info) => setSaved(info.hasKey));
  }, [pending]);
  useEffect(() => {
    setOwnerReauthPrompt(
      () => new Promise<boolean>((resolve) => setPending(() => resolve)),
    );
    return () => setOwnerReauthPrompt(null);
  }, []);
  const finish = (ok: boolean) => {
    pending?.(ok);
    setPending(null);
    setForm({ password: '', code: '' });
    setError(null);
  };
  return (
    <Dialog
      open={pending !== null}
      title={o.reauth.title}
      description={o.reauth.text}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const bridge = ownerBridge();
                const code =
                  saved && bridge?.code
                    ? (await bridge.code()).code
                    : form.code;
                await post('/control/owner/reauth', {
                  password: form.password,
                  code,
                });
                finish(true);
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            {o.reauth.submit}
          </Button>
        </>
      }
    >
      <TextField
        label={o.login.password}
        type="password"
        autoComplete="current-password"
        value={form.password}
        onChange={(event) => setForm({ ...form, password: event.target.value })}
      />
      {!saved && (
        <TextField
          label={o.login.code}
          inputMode="numeric"
          maxLength={6}
          value={form.code}
          onChange={(event) =>
            setForm({ ...form, code: event.target.value.replace(/\D/g, '') })
          }
        />
      )}
      <FormError error={error} />
    </Dialog>
  );
}

type Tab =
  | 'overview'
  | 'customers'
  | 'devices'
  | 'releases'
  | 'security'
  | 'audit'
  | 'ads'
  | 'design'
  | 'local';

/** SUPER_OWNER console: shown on the central server after Owner sign-in. */
export function OwnerConsole({ local }: { local?: ReactNode }) {
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const me = useQuery({
    queryKey: ['owner', 'me'],
    queryFn: async () => {
      try {
        return await ownerApi<OwnerMe>('/owner/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 30_000,
  });
  const catalog = useQuery({
    queryKey: ['owner', 'catalog'],
    queryFn: () => ownerApi<{ features: FeatureDef[] }>('/catalog'),
    enabled: !!me.data,
    staleTime: 10 * 60_000,
  });
  if (me.isPending) return <LoadingState />;
  if (me.error)
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (!me.data)
    return (
      <OwnerLogin
        onDone={() => void client.invalidateQueries({ queryKey: ['owner'] })}
      />
    );
  const tabs: [Tab, string][] = [
    ['overview', o.tabs.overview],
    ['customers', o.tabs.customers],
    ['devices', o.tabs.devices],
    ['releases', o.tabs.releases],
    ['security', o.tabs.security],
    ['audit', o.tabs.audit],
    ['ads', o.tabs.ads],
    ['design', o.tabs.design],
    ...(local ? ([['local', o.tabs.local]] as [Tab, string][]) : []),
  ];
  return (
    <div className="stack">
      <PageHeader title={o.title} subtitle={o.subtitle} />
      <nav className="tabs" aria-label={o.title}>
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab ${tab === key ? 'active' : ''}`}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'customers' &&
        (catalog.data ? (
          <CustomersTab catalog={catalog.data.features} />
        ) : (
          <LoadingState />
        ))}
      {tab === 'devices' && <DevicesTab />}
      {tab === 'releases' && <ReleasesTab />}
      {tab === 'security' && (
        <SecurityTab
          onLogout={async () => {
            await post('/control/owner/logout').catch(() => undefined);
            client.clear();
            void me.refetch();
          }}
        />
      )}
      {tab === 'audit' && <AuditTab />}
      {tab === 'ads' && <AdsTab />}
      {tab === 'design' && <DesignTab />}
      {tab === 'local' && local}
      <ReauthHost />
    </div>
  );
}
