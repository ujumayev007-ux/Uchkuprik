import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
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
import { EventsTab, RegistrationsTab, useUnreadEvents } from './OwnerRegistry';
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
  const [view, setView] = useState<'login' | 'recover'>('login');
  const [form, setForm] = useState({ email: '', password: '', code: '' });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Remember on this computer": the saved key makes the code field unnecessary.
  const [saved, setSaved] = useState(false);
  const [keyText, setKeyText] = useState('');
  // A computer verified with a code before signs in with the password only.
  const [trusted, setTrusted] = useState(false);
  const [trustIt, setTrustIt] = useState(true);
  useEffect(() => {
    void bridge?.rememberGet?.().then((info) => {
      setSaved(info.hasKey);
      if (info.email) setForm((current) => ({ ...current, email: info.email }));
    });
    void bridge?.trustGet?.().then((value) => setTrusted(value.trusted));
  }, [bridge]);
  if (!bridge) return <ErrorState error={new Error(o.login.noBridge)} />;
  if (view === 'recover')
    return (
      <RecoveryForm
        bridge={bridge}
        email={form.email}
        onBack={() => setView('login')}
      />
    );
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
          const code = trusted
            ? undefined
            : saved && bridge.code
              ? (await bridge.code()).code
              : form.code;
          const result = await post<{ trusted?: boolean }>(
            '/control/owner/login',
            {
              email,
              password: form.password,
              challenge,
              deviceKey: key.publicKey,
              deviceSignature,
              deviceLabel: key.label,
              ...(code ? { code } : {}),
              // Stay signed in until the computer restarts (the application ends it then).
              ...(bridge.untilRestart ? { keep: true } : {}),
              ...(!trusted && trustIt && bridge.trustSet
                ? { trustDevice: true }
                : {}),
            },
          );
          // Remember (or forget) that this computer is trusted.
          if (bridge.trustSet)
            await (
              result.trusted
                ? bridge.trustSet({ email })
                : bridge.trustClear?.()
            )?.catch(() => undefined);
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
          else if (
            caught instanceof ApiError &&
            caught.code === 'MFA_REQUIRED' &&
            trusted
          ) {
            // The server no longer trusts this computer: ask for a code once more.
            setTrusted(false);
            await bridge.trustClear?.();
            setNotice(o.login.codeAgain);
          } else setError(caught);
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
      {trusted ? (
        <p className="muted small">
          {o.login.trustedNote}{' '}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await bridge.trustClear?.();
              setTrusted(false);
            }}
          >
            {o.login.askCode}
          </button>
        </p>
      ) : saved ? (
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
      {!trusted && bridge.trustSet && (
        <Checkbox
          label={o.login.trustLabel}
          checked={trustIt}
          onChange={setTrustIt}
        />
      )}
      {notice && <p className="muted small">{notice}</p>}
      <FormError error={error} />
      {error instanceof ApiError && error.code === 'INVALID_CREDENTIALS' && (
        <p className="muted small">{o.login.wrongHint}</p>
      )}
      <div className="form-actions">
        {bridge.trustGet && (
          <Button type="button" onClick={() => setView('recover')}>
            {o.login.forgot}
          </Button>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          {o.login.submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * Account recovery: only from this computer if it was verified with a code before, and
 * only with the one-time recovery key. The server refuses every other computer.
 */
function RecoveryForm({
  bridge,
  email,
  onBack,
}: {
  bridge: NonNullable<ReturnType<typeof ownerBridge>>;
  email: string;
  onBack: () => void;
}) {
  const r = o.recovery;
  const [form, setForm] = useState({
    email,
    key: '',
    password: '',
    again: '',
    resetMfa: false,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ secret?: string } | null>(null);
  if (done)
    return (
      <div
        className="card stack"
        style={{ maxWidth: '28rem', margin: '2rem auto' }}
      >
        <h1>{r.doneTitle}</h1>
        <p>{r.doneText}</p>
        {done.secret && (
          <>
            <p className="muted small">{r.newSecret}</p>
            <code style={{ wordBreak: 'break-all', fontSize: '1.1rem' }}>
              {done.secret}
            </code>
          </>
        )}
        <div className="form-actions">
          <Button variant="primary" onClick={onBack}>
            {r.toLogin}
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className="card stack"
      style={{ maxWidth: '28rem', margin: '2rem auto' }}
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        if (form.password !== form.again) {
          setError(new Error(r.mismatch));
          return;
        }
        setBusy(true);
        try {
          const mail = form.email.trim().toLowerCase();
          const key = await bridge.deviceKey();
          const { challenge } = await post<{ challenge: string }>(
            '/control/owner/challenge',
          );
          const deviceSignature = await bridge.sign({ challenge, email: mail });
          const result = await post<{ secret?: string }>(
            '/control/owner/recovery/reset',
            {
              email: mail,
              challenge,
              deviceKey: key.publicKey,
              deviceSignature,
              recoveryKey: form.key,
              newPassword: form.password,
              resetMfa: form.resetMfa,
            },
          );
          setDone(result.secret ? { secret: result.secret } : {});
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{r.title}</h1>
      <p className="muted small">{r.hint}</p>
      <TextField
        label={o.login.email}
        type="email"
        value={form.email}
        onChange={(event) => setForm({ ...form, email: event.target.value })}
        required
      />
      <TextField
        label={r.key}
        autoComplete="off"
        value={form.key}
        onChange={(event) => setForm({ ...form, key: event.target.value })}
        required
      />
      <TextField
        label={r.newPassword}
        type="password"
        autoComplete="new-password"
        value={form.password}
        onChange={(event) => setForm({ ...form, password: event.target.value })}
        required
      />
      <TextField
        label={r.again}
        type="password"
        autoComplete="new-password"
        value={form.again}
        onChange={(event) => setForm({ ...form, again: event.target.value })}
        required
      />
      <Checkbox
        label={r.resetMfa}
        checked={form.resetMfa}
        onChange={(value) => setForm({ ...form, resetMfa: value })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="button" onClick={onBack}>
          {r.back}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {r.submit}
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

export type OwnerTab = Tab;
type Tab =
  | 'overview'
  | 'customers'
  | 'devices'
  | 'releases'
  | 'security'
  | 'audit'
  | 'ads'
  | 'design'
  | 'events'
  | 'registry'
  | 'local';

/** SUPER_OWNER console: shown on the central server after Owner sign-in. */
export function OwnerConsole({
  local,
  tab: chosen,
  onTab,
  hideTabs = false,
}: {
  local?: ReactNode;
  // Optional outside navigation (the Owner sidebar); without it the tab bar is used.
  tab?: Tab;
  onTab?: (tab: Tab) => void;
  hideTabs?: boolean;
}) {
  const client = useQueryClient();
  const [ownTab, setOwnTab] = useState<Tab>('overview');
  const tab = chosen ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const unread = useUnreadEvents();
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
    [
      'events',
      unread.data?.unread
        ? `${o.tabs.events} (${unread.data.unread})`
        : o.tabs.events,
    ],
    ['registry', o.tabs.registry],
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
      {!hideTabs && (
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
      )}
      {tab === 'overview' && <OverviewTab />}
      {tab === 'events' && (
        <EventsTab onOpenRegistration={() => setTab('registry')} />
      )}
      {tab === 'registry' && <RegistrationsTab />}
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
