import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MediaPicker } from '../../components/DesignParts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import type { AdPanel } from '../../lib/branding';
import { formatDateTime } from '../../lib/format';
import { ownerApi, ownerPost, ownerPut } from '../../lib/owner';

const o = t.owner.ads;
const PANELS: AdPanel[] = ['ADMIN', 'CASHIER', 'WAITER', 'KITCHEN', 'CUSTOMER'];

type Ad = {
  id: string;
  title: string;
  kind: 'TEXT' | 'IMAGE' | 'VIDEO';
  format: 'FULLSCREEN' | 'POPUP' | 'BANNER';
  text: string | null;
  mediaId: string | null;
  panels: AdPanel[];
  targetMode: 'ALL' | 'SELECTED';
  customerIds: string[];
  durationSec: number;
  closable: boolean;
  autoCloseSec: number | null;
  startsAt: string | null;
  endsAt: string | null;
  everyMinutes: number;
  maxPerDay: number | null;
  priority: number;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED';
  stats?: { shown: number; closed: number; delivered: number };
};

type Customer = { id: string; name: string };

const toLocal = (value: string | null) =>
  value ? new Date(value).toISOString().slice(0, 16) : '';
const fromLocal = (value: string) =>
  value ? new Date(value).toISOString() : null;

const blank = (): Ad => ({
  id: '',
  title: '',
  kind: 'TEXT',
  format: 'POPUP',
  text: '',
  mediaId: null,
  panels: ['CASHIER', 'ADMIN'],
  targetMode: 'ALL',
  customerIds: [],
  durationSec: 10,
  closable: true,
  autoCloseSec: null,
  startsAt: null,
  endsAt: null,
  everyMinutes: 0,
  maxPerDay: null,
  priority: 0,
  status: 'ACTIVE',
});

function AdForm({
  initial,
  customers,
  onClose,
  onSaved,
}: {
  initial: Ad;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [ad, setAd] = useState<Ad>(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const set = <K extends keyof Ad>(key: K, value: Ad[K]) =>
    setAd((current) => ({ ...current, [key]: value }));
  const save = async (status: Ad['status']) => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: ad.title,
        kind: ad.kind,
        format: ad.format,
        text: ad.kind === 'TEXT' || ad.text ? ad.text || null : null,
        mediaId: ad.kind === 'TEXT' ? null : ad.mediaId,
        panels: ad.panels,
        targetMode: ad.targetMode,
        customerIds: ad.targetMode === 'SELECTED' ? ad.customerIds : [],
        durationSec: ad.durationSec,
        closable: ad.closable,
        autoCloseSec: ad.autoCloseSec,
        startsAt: ad.startsAt,
        endsAt: ad.endsAt,
        everyMinutes: ad.everyMinutes,
        maxPerDay: ad.maxPerDay,
        priority: ad.priority,
        status,
      };
      if (ad.id) await ownerPut(`/ads/${ad.id}`, body);
      else await ownerPost('/ads', body);
      toast(o.saved);
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  const num =
    (key: 'durationSec' | 'everyMinutes' | 'priority') =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      set(key, Math.max(0, Math.round(Number(event.target.value) || 0)));
  const shown = customers.filter((customer) =>
    customer.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <Dialog
      open
      wide
      title={ad.id ? o.edit : o.create}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button busy={busy} onClick={() => void save('DRAFT')}>
            {o.saveDraft}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => void save('ACTIVE')}
          >
            {ad.id ? o.save : o.sendNow}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label={o.fTitle}
          maxLength={80}
          value={ad.title}
          onChange={(event) => set('title', event.target.value)}
        />
        <div className="design-grid">
          <SelectField
            label={o.fKind}
            value={ad.kind}
            onChange={(event) => set('kind', event.target.value as Ad['kind'])}
          >
            {(['TEXT', 'IMAGE', 'VIDEO'] as const).map((kind) => (
              <option key={kind} value={kind}>
                {o.kind[kind]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={o.fFormat}
            value={ad.format}
            onChange={(event) =>
              set('format', event.target.value as Ad['format'])
            }
          >
            {(['POPUP', 'FULLSCREEN', 'BANNER'] as const).map((format) => (
              <option key={format} value={format}>
                {o.format[format]}
              </option>
            ))}
          </SelectField>
        </div>
        {ad.kind !== 'TEXT' && (
          <>
            <MediaPicker
              label={o.fMedia}
              value={ad.mediaId}
              onChange={(id) => set('mediaId', id)}
              uploadPath="/api/control/media"
              kind={ad.kind === 'VIDEO' ? 'VIDEO' : 'IMAGE'}
              accept={
                ad.kind === 'VIDEO'
                  ? 'video/mp4,video/webm'
                  : 'image/png,image/jpeg,image/webp,image/gif'
              }
            />
            <p className="muted small">{o.videoHint}</p>
          </>
        )}
        <label className="field">
          <span className="field-label">{o.fText}</span>
          <textarea
            rows={3}
            maxLength={500}
            value={ad.text ?? ''}
            onChange={(event) => set('text', event.target.value)}
          />
        </label>

        <fieldset className="stack compact">
          <legend>{o.fPanels}</legend>
          <div className="check-grid">
            {PANELS.map((panel) => (
              <Checkbox
                key={panel}
                label={o.panel[panel]}
                checked={ad.panels.includes(panel)}
                onChange={(on) =>
                  set(
                    'panels',
                    on
                      ? [...ad.panels, panel]
                      : ad.panels.filter((item) => item !== panel),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="stack compact">
          <legend>{o.fTarget}</legend>
          <SelectField
            label={o.fTarget}
            value={ad.targetMode}
            onChange={(event) =>
              set('targetMode', event.target.value as Ad['targetMode'])
            }
          >
            <option value="ALL">{o.targetAll}</option>
            <option value="SELECTED">{o.targetSelected}</option>
          </SelectField>
          {ad.targetMode === 'SELECTED' && (
            <>
              <TextField
                label={t.common.search}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div
                className="check-grid"
                style={{ maxHeight: 180, overflow: 'auto' }}
              >
                {shown.map((customer) => (
                  <Checkbox
                    key={customer.id}
                    label={customer.name}
                    checked={ad.customerIds.includes(customer.id)}
                    onChange={(on) =>
                      set(
                        'customerIds',
                        on
                          ? [...ad.customerIds, customer.id]
                          : ad.customerIds.filter((id) => id !== customer.id),
                      )
                    }
                  />
                ))}
              </div>
            </>
          )}
        </fieldset>

        <div className="design-grid">
          <TextField
            label={o.fDuration}
            type="number"
            min={3}
            max={120}
            value={ad.durationSec}
            onChange={num('durationSec')}
          />
          <TextField
            label={o.fAutoClose}
            type="number"
            min={3}
            max={300}
            value={ad.autoCloseSec ?? ''}
            onChange={(event) =>
              set(
                'autoCloseSec',
                event.target.value ? Number(event.target.value) : null,
              )
            }
          />
          <TextField
            label={o.fStarts}
            type="datetime-local"
            value={toLocal(ad.startsAt)}
            onChange={(event) => set('startsAt', fromLocal(event.target.value))}
          />
          <TextField
            label={o.fEnds}
            type="datetime-local"
            value={toLocal(ad.endsAt)}
            onChange={(event) => set('endsAt', fromLocal(event.target.value))}
          />
          <TextField
            label={o.fEvery}
            type="number"
            min={0}
            max={1440}
            value={ad.everyMinutes}
            onChange={num('everyMinutes')}
          />
          <TextField
            label={o.fMaxDay}
            type="number"
            min={1}
            max={1000}
            value={ad.maxPerDay ?? ''}
            onChange={(event) =>
              set(
                'maxPerDay',
                event.target.value ? Number(event.target.value) : null,
              )
            }
          />
          <TextField
            label={o.fPriority}
            type="number"
            min={0}
            max={100}
            value={ad.priority}
            onChange={num('priority')}
          />
        </div>
        <Checkbox
          label={o.fClosable}
          checked={ad.closable}
          onChange={(on) => set('closable', on)}
        />
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function StatsDialog({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const stats = useQuery({
    queryKey: ['owner', 'ads', ad.id, 'stats'],
    queryFn: () =>
      ownerApi<{
        customers: {
          customerId: string;
          name: string;
          shown: number;
          closed: number;
          delivered: number;
          pending: number;
        }[];
      }>(`/ads/${ad.id}/stats`),
  });
  return (
    <Dialog
      open
      title={`${o.stats}: ${ad.title}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t.common.close}</Button>}
    >
      {stats.isPending ? (
        <LoadingState />
      ) : stats.error ? (
        <ErrorState error={stats.error} />
      ) : stats.data.customers.length === 0 ? (
        <EmptyState title={o.noStats} />
      ) : (
        <ul className="ops-list">
          {stats.data.customers.map((row) => (
            <li key={row.customerId} className="ops-item">
              <div className="grow">
                <strong>{row.name}</strong>
                <div className="muted small">
                  {o.delivered}: {row.delivered} · {o.pending}: {row.pending} ·{' '}
                  {o.shown}: {row.shown} · {o.closed}: {row.closed}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Owner: create, schedule, target, enable and track advertisements. */
export function AdsTab() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [editing, setEditing] = useState<Ad | null>(null);
  const [viewing, setViewing] = useState<Ad | null>(null);
  const ads = useQuery({
    queryKey: ['owner', 'ads'],
    queryFn: () => ownerApi<{ ads: Ad[] }>('/ads'),
    refetchInterval: 30_000,
  });
  const customers = useQuery({
    queryKey: ['owner', 'ads', 'customers'],
    queryFn: () => ownerApi<{ customers: Customer[] }>('/customers'),
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['owner', 'ads'] });
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    }
  };
  if (ads.isPending) return <LoadingState />;
  if (ads.error)
    return <ErrorState error={ads.error} onRetry={() => void ads.refetch()} />;
  const names = new Map(
    (customers.data?.customers ?? []).map((customer) => [
      customer.id,
      customer.name,
    ]),
  );
  return (
    <div className="stack">
      {element}
      <section className="card stack">
        <h3 className="section-title">{o.title}</h3>
        <p className="muted small">{o.hint}</p>
        <div>
          <Button variant="primary" onClick={() => setEditing(blank())}>
            {o.create}
          </Button>
        </div>
      </section>
      {ads.data.ads.length === 0 ? (
        <EmptyState title={o.empty} />
      ) : (
        <ul className="ops-list">
          {ads.data.ads.map((ad) => (
            <li key={ad.id} className="ops-item">
              <div className="grow">
                <strong>{ad.title}</strong>{' '}
                <Badge
                  tone={
                    ad.status === 'ACTIVE'
                      ? 'success'
                      : ad.status === 'PAUSED'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {o.status[ad.status]}
                </Badge>
                <div className="muted small">
                  {o.kind[ad.kind]} · {o.format[ad.format]} ·{' '}
                  {ad.panels.map((panel) => o.panel[panel]).join(', ')} ·{' '}
                  {ad.targetMode === 'ALL'
                    ? o.targetAll
                    : ad.customerIds
                        .map((id) => names.get(id) ?? '—')
                        .join(', ')}
                </div>
                <div className="muted small">
                  {o.schedule}:{' '}
                  {ad.startsAt ? formatDateTime(ad.startsAt) : o.always} —{' '}
                  {ad.endsAt ? formatDateTime(ad.endsAt) : o.always} ·{' '}
                  {o.delivered}: {ad.stats?.delivered ?? 0} · {o.shown}:{' '}
                  {ad.stats?.shown ?? 0} · {o.closed}: {ad.stats?.closed ?? 0}
                </div>
              </div>
              {ad.status === 'ACTIVE' ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void act(() =>
                      ownerPost(`/ads/${ad.id}/status`, { status: 'PAUSED' }),
                    )
                  }
                >
                  {o.pause}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() =>
                    void act(() =>
                      ownerPost(`/ads/${ad.id}/status`, { status: 'ACTIVE' }),
                    )
                  }
                >
                  {o.start}
                </Button>
              )}
              <Button size="sm" onClick={() => setEditing(ad)}>
                {o.edit}
              </Button>
              <Button size="sm" onClick={() => setViewing(ad)}>
                {o.stats}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (!(await confirm(o.deleteAsk))) return;
                  await act(() =>
                    ownerApi(`/ads/${ad.id}`, {
                      method: 'DELETE',
                      body: { confirm: true },
                    }),
                  );
                }}
              >
                {o.delete}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <AdForm
          key={editing.id || 'new'}
          initial={editing}
          customers={customers.data?.customers ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {viewing && <StatsDialog ad={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
