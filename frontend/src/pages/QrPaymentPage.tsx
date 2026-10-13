import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  QrPayPanel,
  useQrPayment,
  type QrPayment,
} from '../components/QrPayPanel';
import {
  Button,
  Checkbox,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage } from '../lib/api';

const q = t.qrPay;
const MAX_IMAGE = 400 * 1024;

/** Owner settings for paying by merchant QR (Paynet etc.). */
export function QrPaymentPage() {
  const toast = useToast();
  const client = useQueryClient();
  const current = useQrPayment();
  const [form, setForm] = useState<QrPayment | null>(null);
  useEffect(() => {
    if (current.data && !form) setForm(current.data);
  }, [current.data, form]);
  if (current.error)
    return (
      <ErrorState
        error={current.error}
        onRetry={() => void current.refetch()}
      />
    );
  if (!form) return <LoadingState />;
  const set = <K extends keyof QrPayment>(key: K, value: QrPayment[K]) =>
    setForm({ ...form, [key]: value });
  return (
    <div className="stack">
      <PageHeader title={q.title} subtitle={q.subtitle} />
      <div className="receipt-design">
        <form
          className="card stack"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api('/settings/qr-payment', { method: 'PUT', body: form });
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['qr-payment'] });
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
          }}
        >
          <Checkbox
            label={q.enabled}
            checked={form.enabled}
            onChange={(value) => set('enabled', value)}
          />
          <div className="form-grid">
            <SelectField
              label={q.provider}
              value={form.provider}
              onChange={(event) =>
                set('provider', event.target.value as QrPayment['provider'])
              }
            >
              {Object.entries(q.providers).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectField>
            <TextField
              label={q.label}
              value={form.label}
              maxLength={40}
              onChange={(e) => set('label', e.target.value)}
            />
          </div>
          <Field label={q.image} hint={q.imageHint}>
            {(id) => (
              <input
                id={id}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > MAX_IMAGE) {
                    toast(q.tooLarge, 'error');
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => set('image', String(reader.result));
                  reader.readAsDataURL(file);
                }}
              />
            )}
          </Field>
          {form.image && (
            <div>
              <Button size="sm" onClick={() => set('image', '')}>
                {q.removeImage}
              </Button>
            </div>
          )}
          <Field label={q.payload} hint={q.payloadHint}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                value={form.payload}
                onChange={(e) => set('payload', e.target.value)}
              />
            )}
          </Field>
          <TextField
            label={q.instructions}
            value={form.instructions}
            maxLength={300}
            onChange={(e) => set('instructions', e.target.value)}
          />
          <Checkbox
            label={q.requireReference}
            checked={form.requireReference}
            onChange={(value) => set('requireReference', value)}
          />
          <p className="muted small">{q.howItWorks}</p>
          <div className="form-actions">
            <Button type="submit" variant="primary">
              {t.common.save}
            </Button>
          </div>
        </form>
        <section className="card stack">
          <h2 className="section-title">{q.preview}</h2>
          {form.image || form.payload ? (
            <QrPayPanel qr={form} amount={45000} />
          ) : (
            <p className="muted">{q.noQr}</p>
          )}
        </section>
      </div>
    </div>
  );
}
