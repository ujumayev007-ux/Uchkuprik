import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
import {
  Badge,
  Button,
  Field,
  FormError,
  LoadingState,
  PageHeader,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { ControlLinkCard } from './ControlLinkCard';

const l = t.license;

export type License = {
  selfHosted: boolean;
  status?: keyof typeof l.status;
  customer?: string | null;
  expiresAt?: string | null;
  daysLeft?: number | null;
  trial?: boolean;
  endsAt?: string | null;
  hoursLeft?: number | null;
  installId?: string;
  hiddenMenus?: string[];
};

export function useLicense(enabled = true) {
  return useQuery({
    queryKey: ['license'],
    queryFn: () => api<License>('/license'),
    enabled,
    staleTime: 60_000,
  });
}

export const licenseBlocks = (license: License | undefined) =>
  !!license?.selfHosted &&
  (license.status === 'EXPIRED' ||
    license.status === 'MISSING' ||
    license.status === 'INVALID' ||
    license.status === 'BLOCKED');

function KeyForm() {
  const client = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await post('/license', { key });
          toast(l.activated);
          setKey('');
          await client.invalidateQueries();
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <Field label={l.key}>
        {(id) => (
          <textarea
            id={id}
            rows={4}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            required
          />
        )}
      </Field>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary">
          {l.activate}
        </Button>
      </div>
    </form>
  );
}

function SyncButton() {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await post('/license/sync');
          toast(l.synced);
          await client.invalidateQueries();
        } catch {
          toast(t.common.errorTitle, 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      {l.sync}
    </Button>
  );
}

export function LicenseDetails({ license }: { license: License }) {
  const { data: me } = useMe();
  const toast = useToast();
  const owner = me?.roleKeys.includes('owner');
  const tone =
    license.status === 'VALID'
      ? 'success'
      : license.status === 'TRIAL' || license.status === 'EXPIRING'
        ? 'warning'
        : 'danger';
  return (
    <div className="stack">
      <section className="card stack">
        <div className="toolbar">
          <h2 className="section-title">{l.title}</h2>
          {license.status && (
            <Badge tone={tone}>{l.status[license.status]}</Badge>
          )}
        </div>
        <dl className="totals">
          {license.customer && (
            <>
              <dt>{l.customer}</dt>
              <dd>{license.customer}</dd>
            </>
          )}
          {license.expiresAt && (
            <>
              <dt>{l.expiresAt}</dt>
              <dd>{license.expiresAt}</dd>
            </>
          )}
          {license.trial && license.endsAt ? (
            <>
              <dt>{l.trialEnds}</dt>
              <dd>
                {new Date(license.endsAt).toLocaleString('uz-UZ')} (
                {l.hoursLeft.replace('{n}', String(license.hoursLeft ?? 0))})
              </dd>
            </>
          ) : (
            <>
              <dt>{l.daysLeft}</dt>
              <dd>{license.daysLeft ?? 0}</dd>
            </>
          )}
        </dl>
        <div className="stack">
          <strong>{l.installId}</strong>
          <p className="secret-box">{license.installId}</p>
          <p className="muted small">{l.installIdHint}</p>
          <p className="muted small">ℹ {t.vendorInstalls.disclosure}</p>
          <div>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(license.installId ?? '')
                  .then(() => toast(l.copied))
                  .catch(() => undefined)
              }
            >
              {l.copy}
            </Button>{' '}
            <SyncButton />
          </div>
        </div>
      </section>
      {owner && (
        <section className="card">
          <KeyForm />
        </section>
      )}
      <ControlLinkCard />
    </div>
  );
}

export function LicensePage() {
  const license = useLicense();
  if (!license.data) return <LoadingState />;
  return (
    <div className="stack">
      <PageHeader title={l.title} />
      <LicenseDetails license={license.data} />
    </div>
  );
}

/** Shown instead of the app when the licence no longer allows use. */
export function LicenseLock({ license }: { license: License }) {
  const { data: me } = useMe();
  const owner = me?.roleKeys.includes('owner');
  return (
    <div className="stack">
      <div className="state">
        <h1>{l.lockedTitle}</h1>
        <p>{owner ? l.lockedText : l.lockedStaff}</p>
      </div>
      <LicenseDetails license={license} />
    </div>
  );
}
