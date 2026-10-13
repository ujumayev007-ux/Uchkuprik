import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage } from '../lib/api';

const r = t.receiptDesign;

export type ReceiptLayout = {
  paperWidth: '58' | '80';
  fontSize: 'small' | 'normal' | 'large';
  showBusinessName: boolean;
  showLegalName: boolean;
  showTaxId: boolean;
  showBranch: boolean;
  showPhone: boolean;
  showCashier: boolean;
  showOrderType: boolean;
  showModifiers: boolean;
  showPayments: boolean;
  title: string;
  extraLines: string;
  thankYou: string;
};

const toggles = [
  'showBusinessName',
  'showLegalName',
  'showTaxId',
  'showBranch',
  'showPhone',
  'showCashier',
  'showOrderType',
  'showModifiers',
  'showPayments',
] as const;

export function ReceiptDesignPage() {
  const toast = useToast();
  const client = useQueryClient();
  const layout = useQuery({
    queryKey: ['receipt-layout'],
    queryFn: () => api<ReceiptLayout>('/settings/receipt'),
  });
  const [form, setForm] = useState<ReceiptLayout | null>(null);
  useEffect(() => {
    if (layout.data && !form) setForm(layout.data);
  }, [layout.data, form]);
  if (layout.error)
    return (
      <ErrorState error={layout.error} onRetry={() => void layout.refetch()} />
    );
  if (!form) return <LoadingState />;
  const set = <K extends keyof ReceiptLayout>(
    key: K,
    value: ReceiptLayout[K],
  ) => setForm({ ...form, [key]: value });
  return (
    <div className="stack">
      <PageHeader title={r.title} subtitle={r.subtitle} />
      <div className="receipt-design">
        <form
          className="card stack"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api('/settings/receipt', { method: 'PUT', body: form });
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['receipt-layout'] });
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
          }}
        >
          <div className="form-grid">
            <SelectField
              label={r.paper}
              value={form.paperWidth}
              onChange={(event) =>
                set(
                  'paperWidth',
                  event.target.value as ReceiptLayout['paperWidth'],
                )
              }
            >
              <option value="80">80 mm</option>
              <option value="58">58 mm</option>
            </SelectField>
            <SelectField
              label={r.font}
              value={form.fontSize}
              onChange={(event) =>
                set('fontSize', event.target.value as ReceiptLayout['fontSize'])
              }
            >
              {Object.entries(r.fonts).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
          <TextField
            label={r.titleText}
            value={form.title}
            maxLength={60}
            onChange={(e) => set('title', e.target.value)}
          />
          <div className="check-grid">
            {toggles.map((key) => (
              <Checkbox
                key={key}
                label={r[key]}
                checked={form[key]}
                onChange={(value) => set(key, value)}
              />
            ))}
          </div>
          <TextField
            label={r.extraLines}
            value={form.extraLines}
            maxLength={500}
            onChange={(e) => set('extraLines', e.target.value)}
          />
          <TextField
            label={r.thankYou}
            value={form.thankYou}
            maxLength={120}
            onChange={(e) => set('thankYou', e.target.value)}
          />
          <p className="muted small">{r.headerFooterHint}</p>
          <div className="form-actions">
            <Button type="submit" variant="primary">
              {t.common.save}
            </Button>
          </div>
        </form>
        <section className="card stack">
          <h2 className="section-title">{r.preview}</h2>
          <div
            className={`receipt-preview paper-${form.paperWidth} font-${form.fontSize}`}
          >
            {form.title && (
              <strong className="center block">{form.title}</strong>
            )}
            {form.showBusinessName && (
              <strong className="center block">FAST FOOD</strong>
            )}
            {form.showLegalName && (
              <div className="center">“Restoran” MChJ</div>
            )}
            {form.showTaxId && <div className="center">STIR: 301234567</div>}
            {form.showBranch && (
              <div className="center">Chilonzor, Bunyodkor 1</div>
            )}
            {form.showPhone && <div className="center">+998 90 000 00 00</div>}
            <hr />
            <div>№ 15 · 13.10.2026 12:30</div>
            {form.showOrderType && <div>Zalda · Stol 4</div>}
            {form.showCashier && <div>Kassir: Dilnoza</div>}
            <hr />
            <div className="preview-row">
              <span>Oila seti</span>
              <span>95 000</span>
            </div>
            {form.showModifiers && (
              <div className="small">2× Burger, 2× Kola, 1× Fri</div>
            )}
            <div className="preview-row">
              <span>Kola</span>
              <span>10 000</span>
            </div>
            <hr />
            <div className="preview-row strong">
              <span>Jami</span>
              <span>105 000</span>
            </div>
            {form.showPayments && (
              <div className="preview-row">
                <span>Naqd</span>
                <span>110 000</span>
              </div>
            )}
            {form.extraLines && (
              <div className="center small pre">{form.extraLines}</div>
            )}
            <div className="center">{form.thankYou}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
