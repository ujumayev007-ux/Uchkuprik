import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Checkbox,
  ErrorState,
  FormError,
  LoadingState,
  SelectField,
  TextField,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { api, post } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import type { Plan } from '../SubscriptionPage';
import { AuthLayout } from './AuthLayout';

/** Self-service sign-up: creates a business with a free trial on the chosen plan. */
export function RegisterPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const plans = useQuery({
    queryKey: ['public-plans'],
    queryFn: () =>
      api<{ plans: Plan[]; signupEnabled: boolean }>('/public/plans'),
  });
  const [form, setForm] = useState({
    businessName: '',
    slug: '',
    branchName: '',
    ownerName: '',
    username: '',
    password: '',
    planCode: '',
  });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });

  if (plans.isPending) return <LoadingState />;
  if (plans.error)
    return (
      <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
    );
  const planCode = form.planCode || plans.data.plans[0]?.code || '';
  const selected = plans.data.plans.find((plan) => plan.code === planCode);

  return (
    <AuthLayout title={t.register.title} subtitle={t.register.subtitle} wide>
      {!plans.data.signupEnabled ? (
        <p className="form-error">{t.register.disabled}</p>
      ) : (
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await post<{ slug: string }>('/public/register', {
                ...form,
                planCode,
                acceptTerms: accepted,
              });
              try {
                localStorage.setItem('ff-last-tenant', result.slug);
              } catch {
                /* Convenience only. */
              }
              toast(t.register.done);
              navigate('/kirish', { replace: true });
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <TextField
              label={t.register.business}
              value={form.businessName}
              onChange={set('businessName')}
              minLength={2}
              maxLength={100}
              required
            />
            <TextField
              label={t.register.slug}
              hint={t.register.slugHint}
              value={form.slug}
              autoCapitalize="none"
              spellCheck={false}
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              onChange={(event) =>
                setForm({ ...form, slug: event.target.value.toLowerCase() })
              }
              required
            />
            <TextField
              label={t.register.branch}
              value={form.branchName}
              onChange={set('branchName')}
              minLength={2}
              maxLength={80}
              required
            />
            <SelectField
              label={t.register.plan}
              hint={
                selected
                  ? `${formatMoney(selected.monthlyPrice)}${t.billing.perMonth} · ${t.register.trial.replace('{days}', String(selected.trialDays))}`
                  : undefined
              }
              value={planCode}
              onChange={(event) =>
                setForm({ ...form, planCode: event.target.value })
              }
            >
              {plans.data.plans.map((plan) => (
                <option key={plan.code} value={plan.code}>
                  {plan.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t.register.owner}
              value={form.ownerName}
              onChange={set('ownerName')}
              autoComplete="name"
              minLength={2}
              maxLength={80}
              required
            />
            <TextField
              label={t.register.username}
              value={form.username}
              autoCapitalize="none"
              autoComplete="username"
              spellCheck={false}
              pattern="[a-z0-9._\-]{3,40}"
              onChange={(event) =>
                setForm({ ...form, username: event.target.value.toLowerCase() })
              }
              required
            />
            <TextField
              label={t.register.password}
              hint={t.auth.passwordRule}
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={form.password}
              onChange={set('password')}
              required
            />
          </div>
          <Checkbox
            label={t.register.terms}
            checked={accepted}
            onChange={setAccepted}
          />
          <FormError error={error} />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={busy}
            disabled={!accepted}
          >
            {t.register.submit}
          </Button>
          <Link className="text-link center" to="/kirish">
            {t.register.haveAccount}
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}
