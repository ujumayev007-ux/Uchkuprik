import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useMe } from '../auth/session';
import { ReceiptSheet, sampleSheet } from '../components/ReceiptSheet';
import {
  Button,
  Checkbox,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage } from '../lib/api';
import {
  columnsForWidth,
  logoFromFile,
  rasterizeLogo,
  normalizeLayout,
  receiptPresets,
  type ReceiptLayout,
} from '../lib/receipt';

const r = t.receiptDesign;
const k = t.receiptTpl;

type Kind = 'CUSTOMER' | 'KITCHEN';
type Assignment = { type: 'PRINTER' | 'STATION' | 'TYPE'; targetId: string };
type Template = {
  id: string;
  name: string;
  kind: Kind;
  settings: ReceiptLayout;
  assignments: Assignment[];
};
type TemplateList = { defaultTemplate: ReceiptLayout; templates: Template[] };
type PrinterRow = { id: string; name: string; kind: Kind | 'RECEIPT' };

// 'default' is the restaurant's original layout; other keys are template ids or 'new'.
type Key = 'default' | 'new' | string;

const visibility = [
  'showBusinessName',
  'showLegalName',
  'showTaxId',
  'showBranch',
  'showPhone',
  'showCashier',
  'showWaiter',
  'showOrderNumber',
  'showDateTime',
  'showOrderType',
  'showTable',
  'showModifiers',
  'showItemUnitPrice',
  'showNotes',
  'showDiscount',
  'showServiceCharge',
  'showPayments',
  'showChange',
  'showDeliveryDetails',
  'showFiscalData',
  'showSocialMedia',
  'showQrCode',
  'showBarcode',
  'largeOrderNumber',
  'showCustomer',
  'showItemCount',
  'showVat',
  'showWifi',
  'showCopyMark',
] as const;

const label = (key: string): string =>
  ((r as Record<string, unknown>)[key] as string | undefined) ??
  ((k as Record<string, unknown>)[key] as string | undefined) ??
  key;

/** Receipt designer: paper, margins, fonts, logo, visible fields, named templates. */
export function ReceiptDesignPage() {
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const client = useQueryClient();
  const { data: me } = useMe();
  const branchId = me?.activeBranchId;
  const list = useQuery({
    queryKey: ['receipt-templates'],
    queryFn: () => api<TemplateList>('/receipt-templates'),
  });
  const printers = useQuery({
    queryKey: ['printers', branchId],
    queryFn: () =>
      api<{ printers: PrinterRow[] }>(
        `/printers${branchId ? `?branchId=${branchId}` : ''}`,
      ).then((data) => data.printers),
    enabled: !!branchId,
  });
  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () =>
      api<{ stations: { id: string; name: string }[] }>(
        '/kitchen/stations',
      ).then((data) => data.stations),
  });
  const [key, setKey] = useState<Key>('default');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('CUSTOMER');
  const [form, setForm] = useState<ReceiptLayout | null>(null);
  const [targets, setTargets] = useState<Assignment[]>([]);
  const [testPrinter, setTestPrinter] = useState('');
  const [busy, setBusy] = useState(false);

  const current = useMemo(
    () => list.data?.templates.find((item) => item.id === key) ?? null,
    [list.data, key],
  );
  // Load the chosen template into the form.
  useEffect(() => {
    if (!list.data) return;
    if (key === 'default') {
      setForm(normalizeLayout(list.data.defaultTemplate));
      setName('');
      setKind('CUSTOMER');
      setTargets([]);
    } else if (current) {
      setForm(normalizeLayout(current.settings));
      setName(current.name);
      setKind(current.kind);
      setTargets(current.assignments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, list.data]);

  if (list.error)
    return (
      <ErrorState error={list.error} onRetry={() => void list.refetch()} />
    );
  if (!list.data || !form) return <LoadingState />;
  const set = <K extends keyof ReceiptLayout>(
    field: K,
    value: ReceiptLayout[K],
  ) => setForm({ ...form, [field]: value });
  const num =
    (field: keyof ReceiptLayout, min: number, max: number) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Math.round(Number(event.target.value));
      if (Number.isFinite(value))
        set(field, Math.min(max, Math.max(min, value)) as never);
    };
  const standard = form.widthMm === 58 || form.widthMm === 80;
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['receipt-templates'] });

  const save = async () => {
    setBusy(true);
    try {
      const sized = { ...form, logoRaster: await rasterizeLogo(form) };
      if (key === 'default') {
        await api('/settings/receipt', { method: 'PUT', body: sized });
        await client.invalidateQueries({ queryKey: ['receipt-layout'] });
      } else if (key === 'new') {
        const created = await api<{ id: string }>('/receipt-templates', {
          method: 'POST',
          body: { name, kind, settings: sized },
        });
        await refresh();
        setKey(created.id);
      } else {
        await api(`/receipt-templates/${key}`, {
          method: 'PUT',
          body: { name, kind, settings: sized },
        });
      }
      toast(k.saved);
      await refresh();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };
  const saveAssignments = async () => {
    try {
      await api(`/receipt-templates/${key}/assignments`, {
        method: 'PUT',
        body: { targets },
      });
      toast(k.assignSaved);
      await refresh();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  };
  const toggle = (type: Assignment['type'], targetId: string) =>
    setTargets((currentTargets) =>
      currentTargets.some(
        (item) => item.type === type && item.targetId === targetId,
      )
        ? currentTargets.filter(
            (item) => !(item.type === type && item.targetId === targetId),
          )
        : [...currentTargets, { type, targetId }],
    );
  const has = (type: Assignment['type'], targetId: string) =>
    targets.some((item) => item.type === type && item.targetId === targetId);
  const matching = (printers.data ?? []).filter((printer) =>
    kind === 'CUSTOMER'
      ? printer.kind === 'RECEIPT'
      : printer.kind === 'KITCHEN',
  );

  return (
    <div className="stack">
      {confirmElement}
      <PageHeader title={r.title} subtitle={r.subtitle} />
      <div className="tpl-list" role="tablist" aria-label={k.templates}>
        <button
          role="tab"
          aria-selected={key === 'default'}
          className={`chip ${key === 'default' ? 'active' : ''}`}
          onClick={() => setKey('default')}
        >
          {k.defaultName}
        </button>
        {list.data.templates.map((template) => (
          <button
            key={template.id}
            role="tab"
            aria-selected={key === template.id}
            className={`chip ${key === template.id ? 'active' : ''}`}
            onClick={() => setKey(template.id)}
          >
            {template.name} · {template.settings.widthMm} mm
          </button>
        ))}
        {key === 'new' && <span className="chip active">{k.add}</span>}
        <Button
          size="sm"
          onClick={() => {
            setKey('new');
            setName('');
            setTargets([]);
          }}
        >
          + {k.add}
        </Button>
      </div>

      <div
        className="card stack compact"
        style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          padding: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div>
            <strong style={{ fontSize: '0.95em' }}>✨ {k.presets}</strong>
            <p className="muted small" style={{ margin: 0 }}>
              6 ta tayyor professional andozadan birini tanlang va o‘zingizga moslang
            </p>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '10px',
            marginTop: '6px',
          }}
        >
          {(
            Object.entries(receiptPresets) as [
              keyof typeof receiptPresets,
              (typeof receiptPresets)[keyof typeof receiptPresets],
            ][]
          ).map(([presetKey, preset]) => (
            <button
              key={presetKey}
              type="button"
              className="btn btn-secondary"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: '8px',
                height: 'auto',
                background:
                  form.presetKey === presetKey ? '#eff6ff' : '#fff',
                borderColor:
                  form.presetKey === presetKey ? '#3b82f6' : '#cbd5e1',
                boxShadow:
                  form.presetKey === presetKey
                    ? '0 0 0 2px rgba(59, 130, 246, 0.25)'
                    : 'none',
              }}
              onClick={() => {
                setForm(
                  normalizeLayout({
                    ...form,
                    ...preset.layout,
                    presetKey,
                  }),
                );
                if (key === 'new' && !name) {
                  setName(preset.name);
                  setKind(preset.kind);
                }
                toast(`${preset.name} — ${k.presetApplied}`);
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: '0.9em',
                  color: '#1e293b',
                }}
              >
                {preset.name}
              </div>
              <div
                style={{
                  fontSize: '0.78em',
                  color: '#64748b',
                  marginTop: '3px',
                  lineHeight: 1.35,
                }}
              >
                {preset.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="receipt-design">
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {key !== 'default' && (
            <div className="form-grid">
              <TextField
                label={k.name}
                value={name}
                maxLength={60}
                required
                onChange={(event) => setName(event.target.value)}
              />
              <SelectField
                label={k.kind}
                value={kind}
                onChange={(event) => setKind(event.target.value as Kind)}
              >
                {Object.entries(k.kinds).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </SelectField>
            </div>
          )}

          <fieldset className="stack compact">
            <legend>{k.paperTitle}</legend>
            <div className="form-grid">
              <SelectField
                label={r.paper}
                value={standard ? String(form.widthMm) : 'custom'}
                onChange={(event) =>
                  set(
                    'widthMm',
                    event.target.value === 'custom'
                      ? 72
                      : Number(event.target.value),
                  )
                }
              >
                <option value="80">80 mm</option>
                <option value="58">58 mm</option>
                <option value="custom">{k.custom}</option>
              </SelectField>
              {!standard && (
                <TextField
                  label={k.widthMm}
                  type="number"
                  min={40}
                  max={112}
                  value={form.widthMm}
                  onChange={num('widthMm', 40, 112)}
                />
              )}
              <SelectField
                label={r.font}
                value={form.fontSize}
                onChange={(event) =>
                  set(
                    'fontSize',
                    event.target.value as ReceiptLayout['fontSize'],
                  )
                }
              >
                {Object.entries(r.fonts).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={k.spacing}
                value={form.lineSpacing}
                onChange={(event) =>
                  set(
                    'lineSpacing',
                    event.target.value as ReceiptLayout['lineSpacing'],
                  )
                }
              >
                {Object.entries(k.spacings).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={k.separatorStyle}
                value={form.separatorStyle || 'dashed'}
                onChange={(event) =>
                  set(
                    'separatorStyle',
                    event.target.value as ReceiptLayout['separatorStyle'],
                  )
                }
              >
                {Object.entries(k.separators).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </SelectField>
            </div>
            <p className="muted small">
              {k.columns.replace(
                '{n}',
                String(
                  columnsForWidth(
                    form.widthMm,
                    form.marginLeftMm + form.marginRightMm,
                  ),
                ),
              )}
            </p>
            <strong className="small">{k.margins}</strong>
            <div className="form-grid">
              <TextField
                label={k.marginLeft}
                type="number"
                min={0}
                max={15}
                value={form.marginLeftMm}
                onChange={num('marginLeftMm', 0, 15)}
              />
              <TextField
                label={k.marginRight}
                type="number"
                min={0}
                max={15}
                value={form.marginRightMm}
                onChange={num('marginRightMm', 0, 15)}
              />
              <TextField
                label={k.marginTop}
                type="number"
                min={0}
                max={30}
                value={form.marginTopMm}
                onChange={num('marginTopMm', 0, 30)}
              />
              <TextField
                label={k.marginBottom}
                type="number"
                min={0}
                max={40}
                value={form.marginBottomMm}
                onChange={num('marginBottomMm', 0, 40)}
              />
            </div>
            <div className="form-grid">
              <SelectField
                label={k.length}
                value={form.lengthMode}
                onChange={(event) =>
                  set(
                    'lengthMode',
                    event.target.value as ReceiptLayout['lengthMode'],
                  )
                }
              >
                <option value="auto">{k.lengthAuto}</option>
                <option value="fixed">{k.lengthFixed}</option>
              </SelectField>
              {form.lengthMode === 'fixed' && (
                <TextField
                  label={k.fixedMm}
                  type="number"
                  min={50}
                  max={800}
                  value={form.fixedLengthMm}
                  onChange={num('fixedLengthMm', 50, 800)}
                />
              )}
            </div>
          </fieldset>

          <fieldset className="stack compact">
            <legend>{k.logoTitle}</legend>
            <div
              className="form-actions"
              style={{ justifyContent: 'flex-start' }}
            >
              <label className="btn btn-secondary btn-md">
                {k.logoPick}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      setForm({
                        ...form,
                        logo: await logoFromFile(file),
                        showLogo: true,
                      });
                    } catch (caught) {
                      toast(errorMessage(caught), 'error');
                    }
                  }}
                />
              </label>
              {form.logo && (
                <Button
                  onClick={() =>
                    setForm({ ...form, logo: '', showLogo: false })
                  }
                >
                  {k.logoRemove}
                </Button>
              )}
            </div>
            <Checkbox
              label={k.showLogo}
              checked={form.showLogo && !!form.logo}
              onChange={(value) => set('showLogo', value)}
            />
            <TextField
              label={k.logoWidth}
              type="number"
              min={10}
              max={100}
              value={form.logoWidthPct}
              onChange={num('logoWidthPct', 10, 100)}
            />
            <SelectField
              label={k.logoAlign}
              value={form.logoAlign}
              onChange={(event) =>
                set(
                  'logoAlign',
                  event.target.value as ReceiptLayout['logoAlign'],
                )
              }
            >
              <option value="left">{k.alignLeft}</option>
              <option value="center">{k.alignCenter}</option>
              <option value="right">{k.alignRight}</option>
            </SelectField>
            <p className="muted small">{k.logoHint}</p>
          </fieldset>

          <TextField
            label={r.titleText}
            value={form.title}
            maxLength={60}
            onChange={(event) => set('title', event.target.value)}
          />
          <fieldset className="stack compact">
            <legend>{k.fields}</legend>
            <div className="check-grid">
              {visibility.map((field) => (
                <Checkbox
                  key={field}
                  label={label(field)}
                  checked={form[field]}
                  onChange={(value) => set(field, value)}
                />
              ))}
              {kind === 'KITCHEN' && (
                <Checkbox
                  label={k.largeItems}
                  checked={form.largeItems}
                  onChange={(value) => set('largeItems', value)}
                />
              )}
            </div>
            {form.showQrCode && (
              <div
                className="form-grid"
                style={{
                  marginTop: '8px',
                  padding: '10px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                }}
              >
                <TextField
                  label={k.qrContent}
                  value={form.qrContent || ''}
                  placeholder="https://t.me/restoran_bot"
                  maxLength={300}
                  onChange={(event) => set('qrContent', event.target.value)}
                />
                <TextField
                  label={k.qrLabel}
                  value={form.qrLabel || ''}
                  placeholder="Fikr bildirish yoki buyurtma uchun skanerlang"
                  maxLength={100}
                  onChange={(event) => set('qrLabel', event.target.value)}
                />
              </div>
            )}
            {form.showVat && (
              <div className="form-grid" style={{ marginTop: '8px', padding: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                <TextField
                  label={k.vatPercent}
                  type="number"
                  min={0}
                  max={30}
                  step={1}
                  value={String(form.vatPercent ?? 12)}
                  onChange={(event) => set('vatPercent', Math.min(30, Math.max(0, Number(event.target.value) || 0)))}
                />
              </div>
            )}
            {form.showWifi && (
              <div className="form-grid" style={{ marginTop: '8px', padding: '10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                <TextField
                  label={k.wifiName}
                  value={form.wifiName || ''}
                  maxLength={60}
                  onChange={(event) => set('wifiName', event.target.value)}
                />
                <TextField
                  label={k.wifiPassword}
                  value={form.wifiPassword || ''}
                  maxLength={60}
                  onChange={(event) => set('wifiPassword', event.target.value)}
                />
                <Checkbox
                  label={k.wifiQr}
                  checked={!!form.wifiQr}
                  onChange={(value) => set('wifiQr', value)}
                />
              </div>
            )}
            {form.showSocialMedia && (
              <div
                style={{
                  marginTop: '8px',
                  padding: '10px',
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                }}
              >
                <TextField
                  label={k.socialMedia}
                  value={form.socialMedia || ''}
                  placeholder="@restoran"
                  maxLength={100}
                  onChange={(event) => set('socialMedia', event.target.value)}
                />
              </div>
            )}
          </fieldset>
          <TextField
            label={r.extraLines}
            value={form.extraLines}
            maxLength={500}
            onChange={(event) => set('extraLines', event.target.value)}
          />
          <TextField
            label={r.thankYou}
            value={form.thankYou}
            maxLength={120}
            onChange={(event) => set('thankYou', event.target.value)}
          />
          <p className="muted small">{r.headerFooterHint}</p>
          <div className="form-actions">
            {key !== 'default' && key !== 'new' && (
              <>
                <Button
                  onClick={() => {
                    setKey('new');
                    setName(`${name} (nusxa)`);
                    setTargets([]);
                  }}
                >
                  {k.copy}
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm(k.removeAsk))) return;
                    try {
                      await api(`/receipt-templates/${key}`, {
                        method: 'DELETE',
                      });
                      setKey('default');
                      await refresh();
                    } catch (caught) {
                      toast(errorMessage(caught), 'error');
                    }
                  }}
                >
                  {k.remove}
                </Button>
              </>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              {t.common.save}
            </Button>
          </div>
        </form>

        <div className="stack">
          <section className="card stack">
            <h2 className="section-title">{r.preview}</h2>
            <p className="muted small">{k.previewHint}</p>
            <div className="receipt-preview-scroll">
              <style>{`.receipt-preview-scroll .receipt-sheet{box-shadow:0 2px 10px #0002}`}</style>
              <ReceiptSheet layout={form} data={sampleSheet()} />
            </div>
            <div
              className="form-actions"
              style={{ justifyContent: 'flex-start' }}
            >
              <Button
                onClick={() => {
                  try {
                    sessionStorage.setItem(
                      'ff-receipt-test',
                      JSON.stringify(form),
                    );
                  } catch {
                    /* Storage blocked: the test page prints the default layout. */
                  }
                  window.open(
                    '/chek-sinov',
                    '_blank',
                    'noopener,width=520,height=760',
                  );
                }}
              >
                {k.testBrowser}
              </Button>
            </div>
            <div className="form-grid">
              <SelectField
                label={k.testPrinter}
                value={testPrinter}
                onChange={(event) => setTestPrinter(event.target.value)}
              >
                <option value="">{k.testChoose}</option>
                {matching.map((printer) => (
                  <option key={printer.id} value={printer.id}>
                    {printer.name}
                  </option>
                ))}
              </SelectField>
              <div className="field" style={{ alignSelf: 'end' }}>
                <Button
                  disabled={!testPrinter}
                  onClick={async () => {
                    try {
                      await api('/receipt-templates/test-print', {
                        method: 'POST',
                        body: {
                          printerId: testPrinter,
                          kind,
                          settings: {
                            ...form,
                            logoRaster: await rasterizeLogo(form),
                          },
                        },
                      });
                      toast(k.testSent);
                    } catch (caught) {
                      toast(errorMessage(caught), 'error');
                    }
                  }}
                >
                  {k.testPrinter}
                </Button>
              </div>
            </div>
          </section>

          {key !== 'default' && key !== 'new' && (
            <section className="card stack">
              <h2 className="section-title">{k.assign}</h2>
              <p className="muted small">{k.assignHint}</p>
              <Checkbox
                label={`${k.assignType}: ${k.kinds[kind]}`}
                checked={has('TYPE', kind)}
                onChange={() => toggle('TYPE', kind)}
              />
              <strong className="small">{k.assignPrinters}</strong>
              {matching.length === 0 ? (
                <p className="muted small">{k.noPrinters}</p>
              ) : (
                matching.map((printer) => (
                  <Checkbox
                    key={printer.id}
                    label={printer.name}
                    checked={has('PRINTER', printer.id)}
                    onChange={() => toggle('PRINTER', printer.id)}
                  />
                ))
              )}
              {kind === 'KITCHEN' && (
                <>
                  <strong className="small">{k.assignStations}</strong>
                  {(stations.data ?? []).map((station) => (
                    <Checkbox
                      key={station.id}
                      label={station.name}
                      checked={has('STATION', station.id)}
                      onChange={() => toggle('STATION', station.id)}
                    />
                  ))}
                </>
              )}
              <div className="form-actions">
                <Button
                  variant="primary"
                  onClick={() => void saveAssignments()}
                >
                  {k.saveAssign}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
