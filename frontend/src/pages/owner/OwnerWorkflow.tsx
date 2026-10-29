import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { ownerApi, ownerPost } from '../../lib/owner';

const w = t.owner.workflow;

type Source = keyof typeof w.sourceLabels;
type ZoneFlow = {
  sources: Source[];
  approval: keyof typeof w.approvalLabels;
  payment: keyof typeof w.paymentLabels;
  advancePercent: number;
  kitchenConfirm: boolean;
  queueTv: boolean;
  deliveryConfirm: boolean;
  edit: keyof typeof w.editLabels;
  cancel: keyof typeof w.cancelLabels;
  discounts: keyof typeof w.discountLabels;
  tableClose: keyof typeof w.tableCloseLabels;
  kitchenPrint: keyof typeof w.kitchenPrintLabels;
  stationId: string | null;
};
type Config = {
  enabled: boolean;
  preset: number | null;
  template: string | null;
  zones: Record<string, ZoneFlow>;
};
type Route = { zone: string; label: string; steps: string[] };
type Issue = { level: 'error' | 'warning'; zone?: string; text: string };
type WorkflowData = {
  active: {
    version: number;
    config: Config;
    note: string | null;
    createdAt: string;
    routes: Route[];
  } | null;
  history: {
    version: number;
    note: string | null;
    createdAt: string;
    enabled: boolean;
    preset: number | null;
  }[];
  presets: {
    id: number;
    name: string;
    steps: string;
    needs: string | null;
    config: Config;
  }[];
  templates: { key: string; name: string; preset: number; config: Config }[];
  zones: { zone: string; label: string }[];
  facts: {
    capabilities: string[];
    stations?: { id: string; name: string }[];
  } | null;
};

function Routes({ routes }: { routes: Route[] }) {
  return (
    <ul className="ops-list">
      {routes.map((route) => (
        <li key={route.zone} className="ops-item">
          <div className="grow">
            <strong>{route.label}</strong>
            <div className="small">{route.steps.join(' → ')}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One zone's settings (advanced controls). */
function ZoneEditor({
  flow,
  stations,
  onChange,
}: {
  flow: ZoneFlow;
  stations: { id: string; name: string }[];
  onChange: (flow: ZoneFlow) => void;
}) {
  const set = <K extends keyof ZoneFlow>(key: K, value: ZoneFlow[K]) =>
    onChange({ ...flow, [key]: value });
  const select = <K extends keyof ZoneFlow>(
    key: K,
    label: string,
    options: Record<string, string>,
  ) => (
    <SelectField
      label={label}
      value={String(flow[key])}
      onChange={(event) => set(key, event.target.value as ZoneFlow[K])}
    >
      {Object.entries(options).map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </SelectField>
  );
  return (
    <div className="stack">
      <fieldset>
        <legend>{w.sources}</legend>
        <div className="check-grid">
          {(Object.keys(w.sourceLabels) as Source[]).map((source) => (
            <Checkbox
              key={source}
              label={w.sourceLabels[source]}
              checked={flow.sources.includes(source)}
              onChange={(on) =>
                set(
                  'sources',
                  on
                    ? [...flow.sources, source]
                    : flow.sources.filter((item) => item !== source),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        {select('approval', w.approval, w.approvalLabels)}
        {select('payment', w.payment, w.paymentLabels)}
        {flow.payment === 'ADVANCE' && (
          <TextField
            label={w.advance}
            type="number"
            min={1}
            max={100}
            value={flow.advancePercent}
            onChange={(event) =>
              set(
                'advancePercent',
                Math.min(100, Math.max(1, Number(event.target.value) || 1)),
              )
            }
          />
        )}
        {select('edit', w.edit, w.editLabels)}
        {select('cancel', w.cancel, w.cancelLabels)}
        {select('discounts', w.discounts, w.discountLabels)}
        {select('tableClose', w.tableClose, w.tableCloseLabels)}
        {select('kitchenPrint', w.kitchenPrint, w.kitchenPrintLabels)}
        <SelectField
          label={w.station}
          value={flow.stationId ?? ''}
          onChange={(event) => set('stationId', event.target.value || null)}
        >
          <option value="">{w.stationAny}</option>
          {stations.map((station) => (
            <option key={station.id} value={station.id}>
              {station.name}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="check-grid">
        <Checkbox
          label={w.kitchenConfirm}
          checked={flow.kitchenConfirm}
          onChange={(on) => set('kitchenConfirm', on)}
        />
        <Checkbox
          label={w.queueTv}
          checked={flow.queueTv}
          onChange={(on) => set('queueTv', on)}
        />
        <Checkbox
          label={w.deliveryConfirm}
          checked={flow.deliveryConfirm}
          onChange={(on) => set('deliveryConfirm', on)}
        />
      </div>
    </div>
  );
}

/**
 * Owner → Mijozlar → Restoran → Ish rejimlari: choose one of the 20 modes or a
 * restaurant template, adjust zones, check and preview, then activate (versioned,
 * with rollback). Nothing changes for the restaurant until "Faollashtirish".
 */
export function WorkflowSection({ customerId }: { customerId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [draft, setDraft] = useState<Config | null>(null);
  const [check, setCheck] = useState<{
    issues: Issue[];
    routes: Route[];
  } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const data = useQuery({
    queryKey: ['owner', 'workflow', customerId],
    queryFn: () => ownerApi<WorkflowData>(`/customers/${customerId}/workflow`),
  });
  if (data.isPending) return <LoadingState />;
  if (!data.data) return null;
  const { active, history, presets, templates, zones, facts } = data.data;
  const stations = facts?.stations ?? [];
  const compatible = facts?.capabilities.includes('workflow') ?? false;
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) toast(done);
      await client.invalidateQueries({
        queryKey: ['owner', 'workflow', customerId],
      });
      return true;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const choose = (config: Config) => {
    setDraft(structuredClone(config));
    setCheck(null);
  };
  const changeDraft = (next: Config) => {
    setDraft(next);
    setCheck(null);
  };
  const preview = () =>
    run(async () =>
      setCheck(
        await ownerPost<{ issues: Issue[]; routes: Route[] }>(
          `/customers/${customerId}/workflow/preview`,
          { config: draft },
        ),
      ),
    );
  const hasErrors =
    check?.issues.some((issue) => issue.level === 'error') ?? true;
  const zoneLabel = (zone: string) =>
    zones.find((item) => item.zone === zone)?.label ?? zone;
  const unused = zones.filter((item) => !draft?.zones[item.zone]);

  return (
    <section className="card stack">
      <h3 className="section-title">{w.title}</h3>
      <p className="muted small">{w.subtitle}</p>
      {!compatible && <p className="notice">{w.compatOld}</p>}
      {active?.config.enabled ? (
        <>
          <p>
            <Badge tone="success">
              {w.active.replace('{version}', String(active.version))}
            </Badge>{' '}
            {active.config.preset &&
              presets.find((preset) => preset.id === active.config.preset)
                ?.name}
          </p>
          <Routes routes={active.routes} />
          <div>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm(w.disableConfirm))) return;
                void run(
                  () =>
                    ownerPost(`/customers/${customerId}/workflow`, {
                      config: { ...active.config, enabled: false },
                      note: null,
                      confirm: true,
                    }),
                  w.disabled,
                );
              }}
            >
              {w.disable}
            </Button>
          </div>
        </>
      ) : (
        <p className="muted">{active ? w.disabled : w.none}</p>
      )}

      <details>
        <summary>{w.presets}</summary>
        <div className="theme-grid">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`theme-option ${draft?.preset === preset.id && !draft.template ? 'active' : ''}`}
              onClick={() => choose(preset.config)}
            >
              <strong>
                {preset.id}. {preset.name}
              </strong>
              <small className="muted">{preset.steps}</small>
              {preset.needs && (
                <Badge tone="warning">
                  {preset.needs === 'credit' ? w.needsCredit : w.needsScheduled}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </details>
      <details>
        <summary>{w.templates}</summary>
        <div className="theme-grid">
          {templates.map((template) => (
            <button
              key={template.key}
              type="button"
              className={`theme-option ${draft?.template === template.key ? 'active' : ''}`}
              onClick={() => choose(template.config)}
            >
              <strong>{template.name}</strong>
            </button>
          ))}
        </div>
      </details>

      {draft && (
        <div className="stack">
          <h4 style={{ margin: 0 }}>{w.draft}</h4>
          {Object.entries(draft.zones).map(([zone, flow]) => (
            <details key={zone} className="card">
              <summary>
                <strong>{zoneLabel(zone)}</strong>
              </summary>
              <ZoneEditor
                flow={flow}
                stations={stations}
                onChange={(next) =>
                  changeDraft({
                    ...draft,
                    zones: { ...draft.zones, [zone]: next },
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const { [zone]: _removed, ...rest } = draft.zones;
                  changeDraft({ ...draft, zones: rest });
                }}
              >
                {w.removeZone}
              </Button>
            </details>
          ))}
          {unused.length > 0 && (
            <SelectField
              label={w.addZone}
              value=""
              onChange={(event) => {
                const zone = event.target.value;
                if (!zone) return;
                const base =
                  Object.values(draft.zones)[0] ??
                  presets[0]!.config.zones.HALL!;
                changeDraft({
                  ...draft,
                  zones: { ...draft.zones, [zone]: structuredClone(base) },
                });
              }}
            >
              <option value="">—</option>
              {unused.map((item) => (
                <option key={item.zone} value={item.zone}>
                  {item.label}
                </option>
              ))}
            </SelectField>
          )}
          <div className="toolbar">
            <Button busy={busy} onClick={() => void preview()}>
              {w.preview}
            </Button>
          </div>
          {check && (
            <div className="stack">
              {check.issues.some((issue) => issue.level === 'error') && (
                <div className="notice danger">
                  <strong>{w.errors}</strong>
                  <ul>
                    {check.issues
                      .filter((issue) => issue.level === 'error')
                      .map((issue, index) => (
                        <li key={index}>
                          {issue.zone ? `${zoneLabel(issue.zone)}: ` : ''}
                          {issue.text}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {check.issues.some((issue) => issue.level === 'warning') && (
                <div className="notice">
                  <strong>{w.warnings}</strong>
                  <ul>
                    {check.issues
                      .filter((issue) => issue.level === 'warning')
                      .map((issue, index) => (
                        <li key={index}>
                          {issue.zone ? `${zoneLabel(issue.zone)}: ` : ''}
                          {issue.text}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              {check.issues.length === 0 && (
                <p className="muted">{w.noIssues}</p>
              )}
              <h4 style={{ margin: 0 }}>{w.route}</h4>
              <Routes routes={check.routes} />
              <TextField
                label={w.note}
                value={note}
                maxLength={200}
                onChange={(event) => setNote(event.target.value)}
              />
              <div>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={hasErrors}
                  onClick={async () => {
                    if (!(await confirm(w.activateConfirm))) return;
                    const saved = await ownerPost<{ version: number }>(
                      `/customers/${customerId}/workflow`,
                      {
                        config: { ...draft, enabled: true },
                        note: note.trim() || null,
                        confirm: true,
                      },
                    ).catch((error: unknown) => {
                      toast(
                        error instanceof Error
                          ? error.message
                          : t.common.errorTitle,
                        'error',
                      );
                      return null;
                    });
                    if (!saved) return;
                    toast(
                      w.activated.replace('{version}', String(saved.version)),
                    );
                    setDraft(null);
                    setCheck(null);
                    setNote('');
                    await client.invalidateQueries({
                      queryKey: ['owner', 'workflow', customerId],
                    });
                  }}
                >
                  {w.activate}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <details>
          <summary>{w.history}</summary>
          <ul className="ops-list">
            {history.map((row) => (
              <li key={row.version} className="ops-item">
                <div className="grow">
                  <strong>v{row.version}</strong>{' '}
                  <Badge tone={row.enabled ? 'success' : 'neutral'}>
                    {row.enabled ? w.enabledShort : w.disabledShort}
                  </Badge>
                  <div className="muted small">
                    {formatDateTime(row.createdAt)}
                    {row.preset
                      ? ` · ${presets.find((p) => p.id === row.preset)?.name ?? ''}`
                      : ''}
                    {row.note ? ` · ${row.note}` : ''}
                  </div>
                </div>
                {active && row.version !== active.version && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirm(
                          w.rollbackConfirm.replace(
                            '{version}',
                            String(row.version),
                          ),
                        ))
                      )
                        return;
                      await run(async () => {
                        const saved = await ownerPost<{ version: number }>(
                          `/customers/${customerId}/workflow/rollback`,
                          { version: row.version, confirm: true },
                        );
                        toast(
                          w.rolledBack.replace(
                            '{version}',
                            String(saved.version),
                          ),
                        );
                      });
                    }}
                  >
                    {w.rollback}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {element}
    </section>
  );
}
