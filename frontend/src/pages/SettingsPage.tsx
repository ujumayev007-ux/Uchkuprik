import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Button,
  Checkbox,
  ErrorState,
  FormError,
  LoadingState,
  PageHeader,
  TextField,
  useToast,
  MoneyField,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch } from '../lib/api';
import { OrderSettingsCard } from './OrderSettingsCard';
import { LoyaltyRulesCard } from './LoyaltyRulesCard';

type Settings = {
  name: string;
  slug: string;
  requireMfaForAdmins: boolean;
  legalName: string | null;
  taxId: string | null;
  phone: string | null;
  address: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  serviceChargeBp: number;
  allowNegativeStock: boolean;
  publicOrdering: boolean;
  loyaltyEarnBp: number;
  overtimeAfterMinutes: number;
  overtimeMultiplierBp: number;
  repairApprovalThreshold: number;
};

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/settings'),
  });
}

export function SettingsPage() {
  const { data: me } = useMe();
  const settings = useSettings();
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const editable = can(me, 'settings.manage');

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  if (settings.isPending || (!form && !settings.error)) return <LoadingState />;
  if (settings.error || !form)
    return (
      <ErrorState
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );

  const text = (key: keyof Settings) => (form[key] as string | null) ?? '';
  const set =
    (key: keyof Settings) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  const nullable = (value: string | null) =>
    value?.trim() ? value.trim() : null;

  return (
    <>
      <PageHeader title={t.settings.title} subtitle={t.settings.subtitle} />
      <form
        className="card stack settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await patch('/settings', {
              name: form.name,
              legalName: nullable(form.legalName),
              taxId: nullable(form.taxId),
              phone: nullable(form.phone),
              address: nullable(form.address),
              receiptHeader: nullable(form.receiptHeader),
              receiptFooter: nullable(form.receiptFooter),
              serviceChargeBp: form.serviceChargeBp,
              requireMfaForAdmins: form.requireMfaForAdmins,
              allowNegativeStock: form.allowNegativeStock,
              publicOrdering: form.publicOrdering,
              loyaltyEarnBp: form.loyaltyEarnBp,
              overtimeAfterMinutes: form.overtimeAfterMinutes,
              overtimeMultiplierBp: form.overtimeMultiplierBp,
              repairApprovalThreshold: form.repairApprovalThreshold,
            });
            toast(t.common.saved);
            await client.invalidateQueries({ queryKey: ['settings'] });
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={!editable}>
          <div className="form-grid">
            <TextField
              label={t.settings.businessName}
              value={form.name}
              onChange={set('name')}
              minLength={2}
              required
            />
            <TextField
              label={`${t.settings.legalName} (${t.common.optional})`}
              value={text('legalName')}
              onChange={set('legalName')}
            />
            <TextField
              label={`${t.settings.taxId} (${t.common.optional})`}
              hint={t.settings.taxIdHint}
              inputMode="numeric"
              pattern="\d{9,14}"
              value={text('taxId')}
              onChange={set('taxId')}
            />
            <TextField
              label={`${t.common.phone} (${t.common.optional})`}
              type="tel"
              value={text('phone')}
              onChange={set('phone')}
            />
            <TextField
              label={`${t.common.address} (${t.common.optional})`}
              value={text('address')}
              onChange={set('address')}
            />
            <TextField
              label={t.settings.serviceCharge}
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={form.serviceChargeBp / 100}
              onChange={(event) =>
                setForm({
                  ...form,
                  serviceChargeBp: Math.round(
                    Number(event.target.value || 0) * 100,
                  ),
                })
              }
            />
            <TextField
              label={`${t.settings.receiptHeader} (${t.common.optional})`}
              value={text('receiptHeader')}
              onChange={set('receiptHeader')}
            />
            <TextField
              label={`${t.settings.receiptFooter} (${t.common.optional})`}
              value={text('receiptFooter')}
              onChange={set('receiptFooter')}
            />
          </div>
          <Checkbox
            label={t.settings.requireMfa}
            description={t.settings.requireMfaHint}
            checked={form.requireMfaForAdmins}
            onChange={(requireMfaForAdmins) =>
              setForm({ ...form, requireMfaForAdmins })
            }
          />
          <TextField
            label={t.crm.loyaltyRate}
            hint={t.crm.loyaltyRateHint}
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={form.loyaltyEarnBp / 100}
            onChange={(event) =>
              setForm({
                ...form,
                loyaltyEarnBp: Math.round(
                  Number(event.target.value || 0) * 100,
                ),
              })
            }
          />
          <TextField
            label={t.hr.overtimeAfter}
            hint={t.hr.laborNote}
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={form.overtimeAfterMinutes / 60}
            onChange={(event) =>
              setForm({
                ...form,
                overtimeAfterMinutes: Math.round(
                  Number(event.target.value || 8) * 60,
                ),
              })
            }
          />
          <TextField
            label={t.hr.overtimeMultiplier}
            type="number"
            min={1}
            max={3}
            step={0.1}
            value={form.overtimeMultiplierBp / 10000}
            onChange={(event) =>
              setForm({
                ...form,
                overtimeMultiplierBp: Math.round(
                  Number(event.target.value || 1.5) * 10000,
                ),
              })
            }
          />
          <MoneyField
            label={t.settings.repairApprovalThreshold}
            value={form.repairApprovalThreshold}
            onChange={(value) =>
              setForm({ ...form, repairApprovalThreshold: value ?? 0 })
            }
          />
          <Checkbox
            label={t.online.enable}
            description={t.online.enableHint}
            checked={form.publicOrdering}
            onChange={(publicOrdering) => setForm({ ...form, publicOrdering })}
          />
          {form.publicOrdering && (
            <p className="muted small">
              {t.online.publicLink}:{' '}
              <a
                className="text-link inline"
                href={`/r/${form.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                {window.location.origin}/r/{form.slug}
              </a>
            </p>
          )}
          <Checkbox
            label={t.inventory.allowNegative}
            description={t.inventory.allowNegativeHint}
            checked={form.allowNegativeStock}
            onChange={(allowNegativeStock) =>
              setForm({ ...form, allowNegativeStock })
            }
          />
        </fieldset>
        <FormError error={error} />
        {editable && (
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={busy}>
              {t.common.save}
            </Button>
          </div>
        )}
      </form>
      <OrderSettingsCard editable={editable} />
      <LoyaltyRulesCard editable={editable} />
    </>
  );
}
