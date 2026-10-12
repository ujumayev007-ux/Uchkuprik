import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import { api, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  branchCount: number;
  userCount: number;
  createdAt: string;
};

function TenantForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    slug: '',
    name: '',
    branchName: '',
    username: '',
    displayName: '',
    password: '',
    planCode: '',
  });
  const plans = useQuery({
    queryKey: ['platform-plans'],
    queryFn: () =>
      api<{ plans: { code: string; name: string; isActive: boolean }[] }>(
        '/platform/plans',
      ),
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/platform/tenants', {
            slug: form.slug,
            name: form.name,
            branchName: form.branchName,
            owner: {
              username: form.username,
              displayName: form.displayName,
              password: form.password,
            },
            ...(form.planCode ? { planCode: form.planCode } : {}),
          });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.tenants.businessName}
          value={form.name}
          onChange={set('name')}
          minLength={2}
          required
        />
        <TextField
          label={t.tenants.slug}
          hint={t.tenants.slugHint}
          value={form.slug}
          pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
          autoCapitalize="none"
          onChange={(event) =>
            setForm({ ...form, slug: event.target.value.toLowerCase() })
          }
          required
        />
        <TextField
          label={t.tenants.firstBranch}
          value={form.branchName}
          onChange={set('branchName')}
          minLength={2}
          required
        />
        <SelectField
          label={t.platformBilling.trialPlan}
          value={form.planCode}
          onChange={(event) =>
            setForm({ ...form, planCode: event.target.value })
          }
        >
          <option value="">{t.platformBilling.noPlan}</option>
          {plans.data?.plans
            .filter((plan) => plan.isActive)
            .map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
        </SelectField>
      </div>
      <fieldset>
        <legend>{t.tenants.owner}</legend>
        <div className="form-grid">
          <TextField
            label={t.tenants.ownerName}
            value={form.displayName}
            onChange={set('displayName')}
            minLength={2}
            required
          />
          <TextField
            label={t.tenants.ownerUsername}
            value={form.username}
            autoCapitalize="none"
            pattern="[a-z0-9._\-]{3,40}"
            onChange={(event) =>
              setForm({ ...form, username: event.target.value.toLowerCase() })
            }
            required
          />
          <TextField
            label={t.tenants.ownerPassword}
            hint={t.auth.passwordRule}
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={form.password}
            onChange={set('password')}
            required
          />
        </div>
      </fieldset>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.create}
        </Button>
      </div>
    </form>
  );
}

export function PlatformTenantsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [creating, setCreating] = useState(false);
  const tenants = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: () =>
      api<{ tenants: Tenant[] }>('/platform/tenants').then(
        (data) => data.tenants,
      ),
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['platform-tenants'] });
  const setStatus = async (tenant: Tenant, status: 'ACTIVE' | 'SUSPENDED') => {
    if (status === 'SUSPENDED' && !(await confirm(t.tenants.suspendConfirm)))
      return;
    try {
      await post(`/platform/tenants/${tenant.id}/status`, { status });
      toast(t.common.saved);
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
        title={t.tenants.title}
        subtitle={t.tenants.subtitle}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            + {t.tenants.add}
          </Button>
        }
      />
      {tenants.isPending ? (
        <LoadingState />
      ) : tenants.error ? (
        <ErrorState
          error={tenants.error}
          onRetry={() => void tenants.refetch()}
        />
      ) : tenants.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.tenants.businessName}</th>
                <th>{t.tenants.slug}</th>
                <th>{t.tenants.branches}</th>
                <th>{t.tenants.users}</th>
                <th>{t.common.status}</th>
                <th>{t.common.createdAt}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {tenants.data.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <strong>{tenant.name}</strong>
                  </td>
                  <td>
                    <code>{tenant.slug}</code>
                  </td>
                  <td>{tenant.branchCount}</td>
                  <td>{tenant.userCount}</td>
                  <td>
                    {tenant.status === 'ACTIVE' ? (
                      <Badge tone="success">{t.common.active}</Badge>
                    ) : tenant.status === 'SUSPENDED' ? (
                      <Badge tone="warning">{t.tenants.suspended}</Badge>
                    ) : (
                      <Badge>{t.tenants.closed}</Badge>
                    )}
                  </td>
                  <td>{formatDateTime(tenant.createdAt)}</td>
                  <td className="right">
                    {tenant.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void setStatus(tenant, 'SUSPENDED')}
                      >
                        {t.tenants.suspend}
                      </Button>
                    )}
                    {tenant.status === 'SUSPENDED' && (
                      <Button
                        size="sm"
                        onClick={() => void setStatus(tenant, 'ACTIVE')}
                      >
                        {t.tenants.reactivate}
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
        open={creating}
        wide
        title={t.tenants.createTitle}
        onClose={() => setCreating(false)}
      >
        {creating && (
          <TenantForm
            onDone={async () => {
              toast(t.common.saved);
              setCreating(false);
              await refresh();
            }}
          />
        )}
      </Dialog>
      {confirmElement}
    </>
  );
}
