import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MediaPicker, SkinPicker } from '../components/DesignParts';
import {
  Button,
  EmptyState,
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
  SKINS,
  type PanelKey,
  type ResolvedDesign,
  type Skin,
} from '../lib/branding';

const d = t.design;
const PANELS: PanelKey[] = [
  'admin',
  'cashier',
  'waiter',
  'kitchen',
  'customer',
];

type AdminLayer = {
  login?: {
    skin?: Skin | null;
    logo?: string | null;
    welcome?: string | null;
    accent?: string | null;
  };
  panels?: Partial<Record<PanelKey, { skin?: Skin | null }>>;
};
type AdminDesign = {
  delegated: boolean;
  design: ResolvedDesign;
  layer: AdminLayer | null;
};

/**
 * Restaurant Admin design: only while the Owner delegated it. The Owner's design stays
 * underneath; removing the restaurant's own choices brings it back.
 */
export function DesignPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const query = useQuery({
    queryKey: ['branding', 'admin'],
    queryFn: () => api<AdminDesign>('/branding/admin'),
  });
  const [layer, setLayer] = useState<AdminLayer | null>(null);
  const [busy, setBusy] = useState(false);
  if (query.isPending) return <LoadingState />;
  if (query.error)
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  const data = query.data;
  if (!data.delegated)
    return (
      <div className="stack">
        <PageHeader title={d.title} subtitle={d.subtitle} />
        <EmptyState title={d.notDelegated} />
      </div>
    );
  const current: AdminLayer = layer ?? data.layer ?? {};
  const setLogin = (patch: NonNullable<AdminLayer['login']>) =>
    setLayer({ ...current, login: { ...current.login, ...patch } });
  const setPanel = (key: PanelKey, skin: Skin | null) =>
    setLayer({
      ...current,
      panels: { ...current.panels, [key]: { skin } },
    });
  const clean = (value: AdminLayer): AdminLayer => {
    const login = Object.fromEntries(
      Object.entries(value.login ?? {}).filter(
        ([, item]) => item !== null && item !== undefined && item !== '',
      ),
    );
    const panels = Object.fromEntries(
      PANELS.flatMap((key) =>
        value.panels?.[key]?.skin
          ? [[key, { skin: value.panels[key]!.skin }]]
          : [],
      ),
    );
    return {
      ...(Object.keys(login).length ? { login } : {}),
      ...(Object.keys(panels).length ? { panels } : {}),
    } as AdminLayer;
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/branding/admin', { method: 'PUT', body: clean(current) });
      await client.invalidateQueries({ queryKey: ['branding'] });
      setLayer(null);
      toast(d.saved);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!(await confirm(d.resetAsk))) return;
    setBusy(true);
    try {
      await api('/branding/admin', {
        method: 'DELETE',
        body: { confirm: true },
      });
      await client.invalidateQueries({ queryKey: ['branding'] });
      setLayer(null);
      toast(d.resetDone);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {element}
      <PageHeader title={d.title} subtitle={d.subtitle} />
      <section className="card stack">
        <h3 className="section-title">{d.loginSkin}</h3>
        <SkinPicker
          value={current.login?.skin ?? null}
          onChange={(skin) => setLogin({ skin })}
          inheritLabel={d.inherit}
        />
        <MediaPicker
          label={d.logo}
          value={current.login?.logo ?? null}
          onChange={(id) => setLogin({ logo: id })}
          uploadPath="/api/branding/admin/media"
        />
        <TextField
          label={d.welcome}
          maxLength={140}
          value={current.login?.welcome ?? ''}
          onChange={(event) => setLogin({ welcome: event.target.value })}
        />
        <div className="row" style={{ alignItems: 'end', gap: 12 }}>
          <label className="field">
            <span className="field-label">{d.accent}</span>
            <input
              type="color"
              value={current.login?.accent ?? '#ce431b'}
              onChange={(event) => setLogin({ accent: event.target.value })}
            />
          </label>
          {current.login?.accent && (
            <Button size="sm" onClick={() => setLogin({ accent: null })}>
              {d.accentClear}
            </Button>
          )}
        </div>
      </section>
      <section className="card stack">
        <h3 className="section-title">{d.panelsTitle}</h3>
        <div className="design-grid">
          {PANELS.map((key) => (
            <SelectField
              key={key}
              label={d.panels[key]}
              value={current.panels?.[key]?.skin ?? ''}
              onChange={(event) =>
                setPanel(key, (event.target.value || null) as Skin | null)
              }
            >
              <option value="">{d.inherit}</option>
              {SKINS.map((skin) => (
                <option key={skin} value={skin}>
                  {skin}
                </option>
              ))}
            </SelectField>
          ))}
        </div>
      </section>
      <div className="form-actions">
        {data.layer && (
          <Button variant="danger" disabled={busy} onClick={() => void reset()}>
            {d.reset}
          </Button>
        )}
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {d.save}
        </Button>
      </div>
    </div>
  );
}
