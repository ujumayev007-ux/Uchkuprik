import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Button,
  FormError,
  MoneyField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';

const l = t.loyaltyRules;

type Tier = { name: string; minSpent: number; bonusBp: number };
type Rules = {
  tiers: Tier[];
  everyNth: { n: number; points: number } | null;
  birthdayPoints: number;
};

const DEFAULT_TIERS: Tier[] = [
  { name: 'Bronze', minSpent: 0, bonusBp: 0 },
  { name: 'Silver', minSpent: 1_000_000, bonusBp: 100 },
  { name: 'Gold', minSpent: 5_000_000, bonusBp: 200 },
  { name: 'VIP', minSpent: 20_000_000, bonusBp: 300 },
];

/** Tiers, every-N-th purchase reward and birthday gift (on top of cashback). */
export function LoyaltyRulesCard({ editable }: { editable: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['settings', 'loyalty-rules'],
    queryFn: () => api<Rules>('/settings/loyalty-rules'),
  });
  const [form, setForm] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);
  if (!form) return null;
  const setTier = (index: number, change: Partial<Tier>) =>
    setForm({
      ...form,
      tiers: form.tiers.map((tier, i) =>
        i === index ? { ...tier, ...change } : tier,
      ),
    });

  return (
    <section className="card stack">
      <h2 className="section-title">🎁 {l.title}</h2>
      <p className="muted small">{l.hint}</p>
      <fieldset className="stack">
        <legend>{l.tiers}</legend>
        {form.tiers.length === 0 && (
          <Button
            size="sm"
            disabled={!editable}
            onClick={() => setForm({ ...form, tiers: DEFAULT_TIERS })}
          >
            {l.addDefault}
          </Button>
        )}
        {form.tiers.map((tier, index) => (
          <div key={index} className="form-grid">
            <TextField
              label={l.tierName}
              value={tier.name}
              onChange={(e) => setTier(index, { name: e.target.value })}
            />
            <MoneyField
              label={l.minSpent}
              value={tier.minSpent}
              onChange={(value) => setTier(index, { minSpent: value ?? 0 })}
            />
            <TextField
              label={l.bonus}
              inputMode="decimal"
              value={String(tier.bonusBp / 100)}
              onChange={(e) =>
                setTier(index, {
                  bonusBp: Math.round(
                    Math.min(
                      50,
                      Number(e.target.value.replace(',', '.')) || 0,
                    ) * 100,
                  ),
                })
              }
            />
          </div>
        ))}
      </fieldset>
      <div className="form-grid">
        <TextField
          label={l.everyN}
          inputMode="numeric"
          value={form.everyNth ? String(form.everyNth.n) : ''}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ''));
            setForm({
              ...form,
              everyNth:
                n >= 2 ? { n, points: form.everyNth?.points ?? 10000 } : null,
            });
          }}
        />
        {form.everyNth && (
          <MoneyField
            label={l.everyNPoints}
            value={form.everyNth.points}
            onChange={(points) =>
              setForm({
                ...form,
                everyNth: { n: form.everyNth!.n, points: points ?? 1 },
              })
            }
          />
        )}
        <MoneyField
          label={l.birthday}
          value={form.birthdayPoints}
          onChange={(value) => setForm({ ...form, birthdayPoints: value ?? 0 })}
        />
      </div>
      <FormError error={error} />
      {editable && (
        <div className="form-actions">
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api('/settings/loyalty-rules', {
                  method: 'PUT',
                  body: form,
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
            {t.common.save}
          </Button>
        </div>
      )}
    </section>
  );
}
