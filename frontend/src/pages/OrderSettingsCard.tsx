import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, FormError, useToast } from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';

const o = t.orderSettings;

export type OrderSettings = {
  requireCashierConfirm: boolean;
  kitchenPrices: boolean;
  waiterCanEditPlaced: boolean;
  cancelPreparingNeedsAck: boolean;
  staffCanCancelPlaced: boolean;
  deliveryCodes: boolean;
};
type Response = { settings: OrderSettings; locked: (keyof OrderSettings)[] };

export function useOrderSettings() {
  return useQuery({
    queryKey: ['settings', 'orders'],
    queryFn: () => api<Response>('/settings/orders'),
  });
}

const KEYS: (keyof OrderSettings)[] = [
  'requireCashierConfirm',
  'kitchenPrices',
  'waiterCanEditPlaced',
  'cancelPreparingNeedsAck',
  'staffCanCancelPlaced',
  'deliveryCodes',
];

/** Order workflow switches; switches locked by the vendor are shown read-only. */
export function OrderSettingsCard({ editable }: { editable: boolean }) {
  const query = useOrderSettings();
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<OrderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (query.data) setForm(query.data.settings);
  }, [query.data]);
  if (!form || !query.data) return null;
  const locked = new Set(query.data.locked);
  return (
    <section className="card stack">
      <h2 className="section-title">{o.title}</h2>
      <p className="muted small">{o.hint}</p>
      {KEYS.map((key) => (
        <div key={key} className="stack-tight">
          <Checkbox
            label={o.labels[key]}
            checked={form[key]}
            disabled={!editable || locked.has(key)}
            onChange={(value) => setForm({ ...form, [key]: value })}
          />
          <small className="muted">
            {o.hints[key]}{' '}
            {locked.has(key) && <Badge tone="warning">🔒 {o.locked}</Badge>}
          </small>
        </div>
      ))}
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
                await api('/settings/orders', { method: 'PUT', body: form });
                toast(t.common.saved);
                await client.invalidateQueries({
                  queryKey: ['settings', 'orders'],
                });
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
