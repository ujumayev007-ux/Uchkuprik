import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useMe } from '../auth/session';
import {
  Button,
  Checkbox,
  FormError,
  MoneyField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';

const g = t.deliveryGps;

type Pricing = {
  enabled: boolean;
  baseFee: number;
  perKm: number;
  minFee: number;
  maxKm: number;
  freeFrom: number;
  roadFactor: number;
};

/** "lat, lng" from free text or a map link (same rule as the server). */
export function parsePoint(text: string) {
  const match = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** Branch location and distance-based delivery pricing. */
export function DeliveryPricingCard() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['delivery', 'pricing', me?.activeBranchId],
    queryFn: () =>
      api<{
        pricing: Pricing;
        branch: { id: string; lat: number | null; lng: number | null };
      }>(`/delivery/pricing?branchId=${me?.activeBranchId ?? ''}`),
    enabled: !!me?.activeBranchId,
  });
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [point, setPoint] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setPricing(query.data.pricing);
    const { lat, lng } = query.data.branch;
    setPoint(lat !== null && lng !== null ? `${lat}, ${lng}` : '');
  }, [query.data]);
  if (!pricing || !query.data) return null;
  const money = (key: keyof Pricing) => (
    <MoneyField
      label={g.fields[key as keyof typeof g.fields]}
      value={pricing[key] as number}
      onChange={(value) => setPricing({ ...pricing, [key]: value ?? 0 })}
    />
  );

  return (
    <section className="card stack">
      <h2 className="section-title">📍 {g.title}</h2>
      <p className="muted small">{g.hint}</p>
      <Checkbox
        label={g.enabled}
        checked={pricing.enabled}
        onChange={(enabled) => setPricing({ ...pricing, enabled })}
      />
      <div className="form-grid">
        <TextField
          label={g.branchPoint}
          hint={g.pointHint}
          value={point}
          onChange={(e) => setPoint(e.target.value)}
        />
        <div>
          <Button
            size="sm"
            onClick={() =>
              navigator.geolocation?.getCurrentPosition(
                (position) =>
                  setPoint(
                    `${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`,
                  ),
                () => toast(g.noGps, 'error'),
              )
            }
          >
            📡 {g.useGps}
          </Button>
        </div>
        {money('baseFee')}
        {money('perKm')}
        {money('minFee')}
        {money('freeFrom')}
        <TextField
          label={g.fields.maxKm}
          inputMode="decimal"
          value={String(pricing.maxKm)}
          onChange={(e) =>
            setPricing({
              ...pricing,
              maxKm: Number(e.target.value.replace(',', '.')) || 0,
            })
          }
        />
        <TextField
          label={g.fields.roadFactor}
          inputMode="decimal"
          value={String(pricing.roadFactor)}
          onChange={(e) =>
            setPricing({
              ...pricing,
              roadFactor: Math.min(
                3,
                Math.max(1, Number(e.target.value.replace(',', '.')) || 1),
              ),
            })
          }
        />
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            const parsed = point.trim() ? parsePoint(point) : null;
            if (point.trim() && !parsed) {
              toast(g.badPoint, 'error');
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await api('/delivery/pricing', {
                method: 'PUT',
                body: {
                  pricing,
                  branch: {
                    id: query.data!.branch.id,
                    lat: parsed?.lat ?? null,
                    lng: parsed?.lng ?? null,
                  },
                },
              });
              toast(t.common.saved);
              await client.invalidateQueries({
                queryKey: ['delivery', 'pricing'],
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
    </section>
  );
}
