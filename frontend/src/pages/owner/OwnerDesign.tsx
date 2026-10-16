import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MediaPicker, SkinPicker } from '../../components/DesignParts';
import {
  Badge,
  Button,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { SKINS, type PanelKey, type Skin } from '../../lib/branding';
import { ownerApi, ownerPut } from '../../lib/owner';

const o = t.owner.design;
const PANELS: PanelKey[] = [
  'admin',
  'cashier',
  'waiter',
  'kitchen',
  'customer',
];

export type Layer = {
  login?: {
    skin?: Skin | null;
    background?: string | null;
    logo?: string | null;
    welcome?: string | null;
    accent?: string | null;
  };
  panels?: Partial<
    Record<PanelKey, { skin?: Skin | null; loginSkin?: Skin | null }>
  >;
  splash?: {
    title?: string | null;
    subtitle?: string | null;
    logo?: string | null;
    skin?: Skin | null;
  };
};

type DesignData = {
  global: Layer | null;
  customers: {
    id: string;
    name: string;
    status: string;
    config: Layer | null;
  }[];
};

/** Removes unset values so the stored layer only holds real decisions. */
export function cleanLayer(layer: Layer): Layer {
  const strip = <T extends Record<string, unknown>>(value: T | undefined) => {
    if (!value) return undefined;
    const entries = Object.entries(value).filter(
      ([, item]) => item !== null && item !== undefined && item !== '',
    );
    return entries.length ? (Object.fromEntries(entries) as T) : undefined;
  };
  const panels = Object.fromEntries(
    PANELS.flatMap((key) => {
      const cleaned = strip(layer.panels?.[key] as Record<string, unknown>);
      return cleaned ? [[key, cleaned]] : [];
    }),
  );
  const login = strip(layer.login as Record<string, unknown>);
  const splash = strip(layer.splash as Record<string, unknown>);
  return {
    ...(login ? { login } : {}),
    ...(Object.keys(panels).length ? { panels } : {}),
    ...(splash ? { splash } : {}),
  } as Layer;
}

/** One design layer: sign-in screen, panel skins and splash. */
function DesignEditor({
  initial,
  onSave,
  onReset,
  canReset,
}: {
  initial: Layer | null;
  onSave: (layer: Layer) => Promise<void>;
  onReset: () => Promise<void>;
  canReset: boolean;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [layer, setLayer] = useState<Layer>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const setLogin = (patch: NonNullable<Layer['login']>) =>
    setLayer((current) => ({
      ...current,
      login: { ...current.login, ...patch },
    }));
  const setPanel = (
    key: PanelKey,
    patch: { skin?: Skin | null; loginSkin?: Skin | null },
  ) =>
    setLayer((current) => ({
      ...current,
      panels: {
        ...current.panels,
        [key]: { ...current.panels?.[key], ...patch },
      },
    }));
  const setSplash = (patch: NonNullable<Layer['splash']>) =>
    setLayer((current) => ({
      ...current,
      splash: { ...current.splash, ...patch },
    }));
  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await action();
      toast(message);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {element}
      <section className="card stack">
        <h4 className="section-title">{o.loginTitle}</h4>
        <span className="field-label">{o.loginSkin}</span>
        <SkinPicker
          value={layer.login?.skin ?? null}
          onChange={(skin) => setLogin({ skin })}
          inheritLabel={o.inherit}
        />
        <div className="design-grid">
          <MediaPicker
            label={o.background}
            value={layer.login?.background}
            onChange={(id) => setLogin({ background: id })}
            uploadPath="/api/control/media"
          />
          <MediaPicker
            label={o.logo}
            value={layer.login?.logo}
            onChange={(id) => setLogin({ logo: id })}
            uploadPath="/api/control/media"
          />
        </div>
        <TextField
          label={o.welcome}
          maxLength={140}
          value={layer.login?.welcome ?? ''}
          onChange={(event) => setLogin({ welcome: event.target.value })}
        />
        <div className="row" style={{ alignItems: 'end', gap: 12 }}>
          <label className="field">
            <span className="field-label">{o.accent}</span>
            <input
              type="color"
              value={layer.login?.accent ?? '#ce431b'}
              onChange={(event) => setLogin({ accent: event.target.value })}
            />
          </label>
          {layer.login?.accent && (
            <Button size="sm" onClick={() => setLogin({ accent: null })}>
              {o.accentClear}
            </Button>
          )}
        </div>
      </section>

      <section className="card stack">
        <h4 className="section-title">{o.panelsTitle}</h4>
        <div className="design-grid">
          {PANELS.map((key) => (
            <div key={key} className="stack compact">
              <strong>{t.design.panels[key]}</strong>
              <SelectField
                label={o.panelSkin}
                value={layer.panels?.[key]?.skin ?? ''}
                onChange={(event) =>
                  setPanel(key, {
                    skin: (event.target.value || null) as Skin | null,
                  })
                }
              >
                <option value="">{o.inherit}</option>
                {SKINS.map((skin) => (
                  <option key={skin} value={skin}>
                    {skin}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={o.panelLogin}
                value={layer.panels?.[key]?.loginSkin ?? ''}
                onChange={(event) =>
                  setPanel(key, {
                    loginSkin: (event.target.value || null) as Skin | null,
                  })
                }
              >
                <option value="">{o.inherit}</option>
                {SKINS.map((skin) => (
                  <option key={skin} value={skin}>
                    {skin}
                  </option>
                ))}
              </SelectField>
            </div>
          ))}
        </div>
      </section>

      <section className="card stack">
        <h4 className="section-title">{o.splashTitle}</h4>
        <div className="design-grid">
          <TextField
            label={o.splashName}
            maxLength={60}
            value={layer.splash?.title ?? ''}
            onChange={(event) => setSplash({ title: event.target.value })}
          />
          <TextField
            label={o.splashSub}
            maxLength={100}
            value={layer.splash?.subtitle ?? ''}
            onChange={(event) => setSplash({ subtitle: event.target.value })}
          />
          <MediaPicker
            label={o.logo}
            value={layer.splash?.logo}
            onChange={(id) => setSplash({ logo: id })}
            uploadPath="/api/control/media"
          />
        </div>
      </section>

      <div className="form-actions">
        {canReset && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirm(o.resetAsk))) return;
              await run(async () => {
                await onReset();
                setLayer({});
              }, o.resetDone);
            }}
          >
            {o.reset}
          </Button>
        )}
        <Button
          variant="primary"
          busy={busy}
          onClick={() => void run(() => onSave(cleanLayer(layer)), o.saved)}
        >
          {o.save}
        </Button>
      </div>
    </div>
  );
}

/** Owner: preview the six skins and assign designs to all or to single restaurants. */
export function DesignTab() {
  const client = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const data = useQuery({
    queryKey: ['owner', 'design'],
    queryFn: () => ownerApi<DesignData>('/design'),
  });
  if (data.isPending) return <LoadingState />;
  if (data.error)
    return (
      <ErrorState error={data.error} onRetry={() => void data.refetch()} />
    );
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['owner', 'design'] });
  const customer = data.data.customers.find((item) => item.id === customerId);
  return (
    <div className="stack">
      <section className="card stack">
        <h3 className="section-title">{o.title}</h3>
        <p className="muted small">{o.hint}</p>
        <p className="muted small">{o.delegatedHint}</p>
        <h4 className="section-title">{o.skins}</h4>
        <SkinPicker value={null} onChange={() => undefined} />
      </section>

      <section className="stack">
        <h3 className="section-title">{o.globalTitle}</h3>
        <DesignEditor
          key={`global-${JSON.stringify(data.data.global)}`}
          initial={data.data.global}
          canReset={data.data.global !== null}
          onSave={async (layer) => {
            await ownerPut('/design/global', layer);
            await refresh();
          }}
          onReset={async () => {
            await ownerApi('/design/global', {
              method: 'DELETE',
              body: { confirm: true },
            });
            await refresh();
          }}
        />
      </section>

      <section className="stack">
        <h3 className="section-title">{o.customerTitle}</h3>
        <SelectField
          label={o.pickCustomer}
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        >
          <option value="">—</option>
          {data.data.customers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.config ? ' ●' : ''}
            </option>
          ))}
        </SelectField>
        {customer && (
          <>
            <p className="muted small">
              <Badge tone={customer.config ? 'success' : 'neutral'}>
                {customer.config ? o.customized : o.noneCustom}
              </Badge>{' '}
              {o.customerHint}
            </p>
            <DesignEditor
              key={`${customer.id}-${JSON.stringify(customer.config)}`}
              initial={customer.config}
              canReset={customer.config !== null}
              onSave={async (layer) => {
                await ownerPut(`/customers/${customer.id}/design`, layer);
                await refresh();
              }}
              onReset={async () => {
                await ownerApi(`/customers/${customer.id}/design`, {
                  method: 'DELETE',
                  body: { confirm: true },
                });
                await refresh();
              }}
            />
          </>
        )}
      </section>
    </div>
  );
}
