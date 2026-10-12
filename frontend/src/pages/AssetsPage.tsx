import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBranches } from '../components/AppShell';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, ApiError, errorMessage, patch, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

const a = t.assets;
type Tab = keyof typeof a.tabs;

type Asset = {
  id: string;
  branchId: string;
  tag: string;
  name: string;
  category: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  location: string | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyUntil: string | null;
  status: keyof typeof a.status;
  notes: string | null;
  nextMaintenance?: { nextDueAt: string; title: string } | null;
  openTickets?: number;
};
type Ticket = {
  id: string;
  title: string;
  description: string;
  priority: keyof typeof a.priority;
  status: keyof typeof a.ticketStatus;
  technician: string | null;
  laborCost: number;
  partsCost: number;
  resolution: string | null;
  downtimeStart: string;
  downtimeEnd: string | null;
  asset?: { name: string; tag: string };
};
type AssetDetail = {
  asset: Asset & {
    plans: {
      id: string;
      title: string;
      intervalDays: number;
      nextDueAt: string;
      lastDoneAt: string | null;
      isActive: boolean;
    }[];
    tickets: Ticket[];
    events: {
      id: string;
      type: string;
      note: string | null;
      cost: number | null;
      passed: boolean | null;
      createdAt: string;
    }[];
    branch: { name: string };
  };
  maintenanceCost: number;
  downtimeHours: number;
  warrantyActive: boolean;
};

const date = (value: string | null | undefined) =>
  value ? value.slice(0, 10) : '—';

function useAction() {
  const toast = useToast();
  const client = useQueryClient();
  return async (run: () => Promise<unknown>) => {
    try {
      await run();
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['assets'] });
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };
}

function AssetForm({
  asset,
  onDone,
}: {
  asset: Asset | null;
  onDone: () => void;
}) {
  const { data: me } = useMe();
  const branches = useBranches();
  const [form, setForm] = useState({
    branchId: asset?.branchId ?? me?.activeBranchId ?? '',
    tag: asset?.tag ?? '',
    name: asset?.name ?? '',
    category: asset?.category ?? '',
    serialNumber: asset?.serialNumber ?? '',
    manufacturer: asset?.manufacturer ?? '',
    model: asset?.model ?? '',
    location: asset?.location ?? '',
    purchaseDate: asset?.purchaseDate?.slice(0, 10) ?? '',
    purchaseCost: asset?.purchaseCost ?? null,
    warrantyUntil: asset?.warrantyUntil?.slice(0, 10) ?? '',
    notes: asset?.notes ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  // Without an active branch, default to the first branch shown in the list.
  const branchId = form.branchId || branches.data?.[0]?.id || '';
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const body = {
          ...form,
          branchId,
          purchaseDate: form.purchaseDate || null,
          warrantyUntil: form.warrantyUntil || null,
        };
        try {
          if (asset) await api(`/assets/${asset.id}`, { method: 'PUT', body });
          else await post('/assets', body);
          onDone();
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          onChange={set('name')}
          required
        />
        <TextField
          label={a.tag}
          hint={a.tagHint}
          value={form.tag}
          pattern="[A-Za-z0-9\-]{2,30}"
          onChange={(event) =>
            setForm({ ...form, tag: event.target.value.toUpperCase() })
          }
          required
        />
        <TextField
          label={a.category}
          value={form.category}
          onChange={set('category')}
          required
        />
        <SelectField
          label={t.nav.branch}
          value={branchId}
          onChange={(event) =>
            setForm({ ...form, branchId: event.target.value })
          }
          required
        >
          {(branches.data ?? []).map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={`${a.location} (${t.common.optional})`}
          value={form.location}
          onChange={set('location')}
        />
        <TextField
          label={`${a.serial} (${t.common.optional})`}
          value={form.serialNumber}
          onChange={set('serialNumber')}
        />
        <TextField
          label={`${a.manufacturer} (${t.common.optional})`}
          value={form.manufacturer}
          onChange={set('manufacturer')}
        />
        <TextField
          label={`${a.model} (${t.common.optional})`}
          value={form.model}
          onChange={set('model')}
        />
        <TextField
          label={`${a.purchaseDate} (${t.common.optional})`}
          type="date"
          value={form.purchaseDate}
          onChange={set('purchaseDate')}
        />
        <MoneyField
          label={`${a.purchaseCost} (${t.common.optional})`}
          value={form.purchaseCost}
          onChange={(purchaseCost) => setForm({ ...form, purchaseCost })}
        />
        <TextField
          label={`${a.warranty} (${t.common.optional})`}
          type="date"
          value={form.warrantyUntil}
          onChange={set('warrantyUntil')}
        />
        <TextField
          label={`${a.notes} (${t.common.optional})`}
          value={form.notes}
          onChange={set('notes')}
        />
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={!branchId}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function CloseTicketDialog({
  ticket,
  onClose,
}: {
  ticket: Ticket;
  onClose: () => void;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState({
    technician: ticket.technician ?? '',
    laborCost: ticket.laborCost as number | null,
    partName: '',
    partCost: null as number | null,
    resolution: ticket.resolution ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const submit = async (status: 'IN_PROGRESS' | 'DONE' | 'CANCELLED') => {
    setError(null);
    try {
      await patch(`/repair-tickets/${ticket.id}`, {
        status,
        technician: form.technician.trim() || null,
        laborCost: form.laborCost ?? 0,
        parts:
          form.partName.trim() && form.partCost !== null
            ? [{ name: form.partName.trim(), quantity: 1, cost: form.partCost }]
            : [],
        resolution: form.resolution.trim() || null,
      });
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['assets'] });
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'APPROVAL_REQUIRED') {
        toast(a.approvalRequested);
        await client.invalidateQueries({ queryKey: ['assets'] });
        onClose();
        return;
      }
      setError(caught);
    }
  };
  return (
    <Dialog
      open
      wide
      title={ticket.title}
      description={ticket.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void submit('CANCELLED')}>
            {a.cancelTicket}
          </Button>
          <Button onClick={() => void submit('IN_PROGRESS')}>
            {a.inProgress}
          </Button>
          <Button variant="primary" onClick={() => void submit('DONE')}>
            {a.finish}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <TextField
          label={a.technician}
          value={form.technician}
          onChange={(event) =>
            setForm({ ...form, technician: event.target.value })
          }
        />
        <MoneyField
          label={a.laborCost}
          value={form.laborCost}
          onChange={(laborCost) => setForm({ ...form, laborCost })}
        />
        <TextField
          label={a.part}
          value={form.partName}
          onChange={(event) =>
            setForm({ ...form, partName: event.target.value })
          }
        />
        <MoneyField
          label={a.partCost}
          value={form.partCost}
          onChange={(partCost) => setForm({ ...form, partCost })}
        />
        <TextField
          label={a.resolution}
          value={form.resolution}
          onChange={(event) =>
            setForm({ ...form, resolution: event.target.value })
          }
        />
      </div>
      <FormError error={error} />
    </Dialog>
  );
}

function AssetDetailDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const action = useAction();
  const manage = can(me, 'assets.manage');
  const [ticket, setTicket] = useState({
    title: '',
    description: '',
    priority: 'NORMAL',
  });
  const [plan, setPlan] = useState({
    title: '',
    intervalDays: '30',
    firstDueAt: new Date().toISOString().slice(0, 10),
  });
  const [closing, setClosing] = useState<Ticket | null>(null);
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: ['assets', 'detail', id],
    queryFn: () => api<AssetDetail>(`/assets/${id}`),
  });
  const data = detail.data;
  return (
    <Dialog open wide title={data?.asset.name ?? a.title} onClose={onClose}>
      {!data ? (
        detail.error ? (
          <ErrorState
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <LoadingState />
        )
      ) : editing ? (
        <AssetForm asset={data.asset} onDone={() => setEditing(false)} />
      ) : (
        <div className="stack">
          <dl className="totals">
            <dt>{a.tag}</dt>
            <dd>{data.asset.tag}</dd>
            <dt>{t.nav.branch}</dt>
            <dd>{data.asset.branch.name}</dd>
            <dt>{a.warranty}</dt>
            <dd>
              {date(data.asset.warrantyUntil)}{' '}
              {data.asset.warrantyUntil && (
                <Badge tone={data.warrantyActive ? 'success' : 'danger'}>
                  {data.warrantyActive ? a.warrantyActive : a.warrantyExpired}
                </Badge>
              )}
            </dd>
            <dt>{a.maintenanceCost}</dt>
            <dd>{formatMoney(data.maintenanceCost)}</dd>
            <dt>{a.downtime}</dt>
            <dd>
              {data.downtimeHours} {a.hours}
            </dd>
          </dl>
          <div className="toolbar">
            <Button
              size="sm"
              onClick={() =>
                void action(() =>
                  post(`/assets/${id}/safety-checks`, { passed: true }),
                )
              }
            >
              {a.safetyPassed}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void action(() =>
                  post(`/assets/${id}/safety-checks`, {
                    passed: false,
                    note: a.safetyFailedNote,
                  }),
                )
              }
            >
              {a.safetyFailed}
            </Button>
            {manage && (
              <Button size="sm" onClick={() => setEditing(true)}>
                {t.common.edit}
              </Button>
            )}
          </div>

          <h3>{a.tickets}</h3>
          <ul className="ops-list">
            {data.asset.tickets.map((row) => (
              <li key={row.id} className="ops-item">
                <div className="grow">
                  <strong>{row.title}</strong>
                  <div className="muted small">
                    {formatDateTime(row.downtimeStart)} ·{' '}
                    {a.priority[row.priority]}
                    {row.status === 'DONE' &&
                      ` · ${formatMoney(row.laborCost + row.partsCost)}`}
                  </div>
                </div>
                <Badge tone={row.status === 'DONE' ? 'success' : 'warning'}>
                  {a.ticketStatus[row.status]}
                </Badge>
                {manage &&
                  (row.status === 'OPEN' || row.status === 'IN_PROGRESS') && (
                    <Button size="sm" onClick={() => setClosing(row)}>
                      {t.common.edit}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await action(() => post(`/assets/${id}/tickets`, ticket)))
                setTicket({ title: '', description: '', priority: 'NORMAL' });
            }}
          >
            <TextField
              label={a.problem}
              value={ticket.title}
              minLength={3}
              onChange={(event) =>
                setTicket({ ...ticket, title: event.target.value })
              }
              required
            />
            <TextField
              label={a.details}
              value={ticket.description}
              minLength={3}
              onChange={(event) =>
                setTicket({ ...ticket, description: event.target.value })
              }
              required
            />
            <SelectField
              label={a.priorityLabel}
              value={ticket.priority}
              onChange={(event) =>
                setTicket({ ...ticket, priority: event.target.value })
              }
            >
              {Object.entries(a.priority).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectField>
            <div className="form-actions">
              <Button type="submit" variant="primary">
                {a.reportProblem}
              </Button>
            </div>
          </form>

          <h3>{a.plans}</h3>
          <ul className="ops-list">
            {data.asset.plans.map((row) => (
              <li key={row.id} className="ops-item">
                <div className="grow">
                  <strong>{row.title}</strong>
                  <div className="muted small">
                    {a.every} {row.intervalDays} {a.days} · {a.nextDue}:{' '}
                    {date(row.nextDueAt)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {manage && (
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  await action(() =>
                    post(`/assets/${id}/plans`, {
                      title: plan.title,
                      intervalDays: Number(plan.intervalDays),
                      firstDueAt: plan.firstDueAt,
                    }),
                  )
                )
                  setPlan({ ...plan, title: '' });
              }}
            >
              <TextField
                label={a.planTitle}
                value={plan.title}
                minLength={2}
                onChange={(event) =>
                  setPlan({ ...plan, title: event.target.value })
                }
                required
              />
              <TextField
                label={a.intervalDays}
                inputMode="numeric"
                pattern="\d{1,4}"
                value={plan.intervalDays}
                onChange={(event) =>
                  setPlan({ ...plan, intervalDays: event.target.value })
                }
                required
              />
              <TextField
                label={a.firstDue}
                type="date"
                value={plan.firstDueAt}
                onChange={(event) =>
                  setPlan({ ...plan, firstDueAt: event.target.value })
                }
                required
              />
              <div className="form-actions">
                <Button type="submit">{a.addPlan}</Button>
              </div>
            </form>
          )}

          <h3>{a.history}</h3>
          <ul className="ops-list">
            {data.asset.events.map((row) => (
              <li key={row.id} className="ops-item">
                <div className="grow">
                  <strong>
                    {(a.events as Record<string, string>)[row.type] ?? row.type}
                  </strong>
                  {row.passed === false && <> · ✗</>}
                  {row.note && <div className="small">{row.note}</div>}
                </div>
                {row.cost !== null && <span>{formatMoney(row.cost)}</span>}
                <span className="muted small">
                  {formatDateTime(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {closing && (
        <CloseTicketDialog ticket={closing} onClose={() => setClosing(null)} />
      )}
    </Dialog>
  );
}

function AssetsTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const assets = useQuery({
    queryKey: ['assets', 'list'],
    queryFn: () =>
      api<{ assets: Asset[] }>('/assets').then((data) => data.assets),
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const found = await api<{ id: string }>(
                `/assets/by-tag/${encodeURIComponent(tag.trim())}`,
              );
              setOpenId(found.id);
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            }
          }}
        >
          <TextField
            label={a.findByTag}
            value={tag}
            onChange={(event) => setTag(event.target.value.toUpperCase())}
          />
          <Button type="submit">{t.common.search}</Button>
        </form>
        {can(me, 'assets.manage') && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            + {a.add}
          </Button>
        )}
      </div>
      {assets.isPending ? (
        <LoadingState />
      ) : assets.error ? (
        <ErrorState
          error={assets.error}
          onRetry={() => void assets.refetch()}
        />
      ) : assets.data.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="ops-list">
          {assets.data.map((asset) => (
            <li
              key={asset.id}
              className={`ops-item ${asset.status === 'IN_REPAIR' ? 'alarm' : ''}`}
            >
              <div className="grow">
                <strong>{asset.name}</strong>{' '}
                <span className="muted small">{asset.tag}</span>
                <div className="muted small">
                  {asset.category}
                  {asset.nextMaintenance &&
                    ` · ${a.nextDue}: ${date(asset.nextMaintenance.nextDueAt)}`}
                </div>
              </div>
              <Badge
                tone={
                  asset.status === 'ACTIVE'
                    ? 'success'
                    : asset.status === 'IN_REPAIR'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {a.status[asset.status]}
              </Badge>
              <Button size="sm" onClick={() => setOpenId(asset.id)}>
                {a.open}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={adding} title={a.add} onClose={() => setAdding(false)} wide>
        {adding && (
          <AssetForm
            asset={null}
            onDone={() => {
              setAdding(false);
              void client.invalidateQueries({ queryKey: ['assets'] });
            }}
          />
        )}
      </Dialog>
      {openId && (
        <AssetDetailDialog id={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function TicketsTab() {
  const tickets = useQuery({
    queryKey: ['assets', 'tickets'],
    queryFn: () =>
      api<{ tickets: Ticket[] }>('/repair-tickets').then(
        (data) => data.tickets,
      ),
  });
  if (tickets.isPending) return <LoadingState />;
  if (tickets.error)
    return (
      <ErrorState
        error={tickets.error}
        onRetry={() => void tickets.refetch()}
      />
    );
  if (tickets.data.length === 0) return <EmptyState />;
  return (
    <ul className="ops-list">
      {tickets.data.map((row) => (
        <li key={row.id} className="ops-item">
          <div className="grow">
            <strong>{row.title}</strong>
            <div className="muted small">
              {row.asset?.name} ({row.asset?.tag}) ·{' '}
              {formatDateTime(row.downtimeStart)}
            </div>
          </div>
          <Badge
            tone={
              row.priority === 'URGENT' || row.priority === 'HIGH'
                ? 'danger'
                : 'neutral'
            }
          >
            {a.priority[row.priority]}
          </Badge>
          <Badge tone="warning">{a.ticketStatus[row.status]}</Badge>
        </li>
      ))}
    </ul>
  );
}

type Contract = {
  id: string;
  vendor: string;
  phone: string | null;
  scope: string;
  startDate: string;
  endDate: string | null;
  cost: number;
  isActive: boolean;
};

function ContractsTab() {
  const { data: me } = useMe();
  const action = useAction();
  const [form, setForm] = useState({
    vendor: '',
    phone: '',
    scope: '',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    cost: null as number | null,
  });
  const contracts = useQuery({
    queryKey: ['assets', 'contracts'],
    queryFn: () =>
      api<{ contracts: Contract[] }>('/service-contracts').then(
        (data) => data.contracts,
      ),
  });
  return (
    <div className="stack">
      {can(me, 'assets.manage') && (
        <form
          className="card form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await action(() =>
                post('/service-contracts', {
                  ...form,
                  phone: form.phone.trim() || null,
                  endDate: form.endDate || null,
                  cost: form.cost ?? 0,
                }),
              )
            )
              setForm({
                ...form,
                vendor: '',
                phone: '',
                scope: '',
                cost: null,
              });
          }}
        >
          <TextField
            label={a.vendor}
            value={form.vendor}
            onChange={(e) => setForm({ ...form, vendor: e.target.value })}
            required
          />
          <TextField
            label={`${t.common.phone} (${t.common.optional})`}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <TextField
            label={a.scope}
            value={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.value })}
            required
          />
          <TextField
            label={a.start}
            type="date"
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            required
          />
          <TextField
            label={`${a.end} (${t.common.optional})`}
            type="date"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
          <MoneyField
            label={a.contractCost}
            value={form.cost}
            onChange={(cost) => setForm({ ...form, cost })}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary">
              + {a.addContract}
            </Button>
          </div>
        </form>
      )}
      {contracts.data?.length === 0 && <EmptyState />}
      <ul className="ops-list">
        {(contracts.data ?? []).map((row) => (
          <li key={row.id} className="ops-item">
            <div className="grow">
              <strong>{row.vendor}</strong>{' '}
              {row.phone && <span className="muted small">{row.phone}</span>}
              <div className="small">{row.scope}</div>
              <div className="muted small">
                {date(row.startDate)} – {date(row.endDate)} ·{' '}
                {formatMoney(row.cost)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AssetsPage() {
  const [tab, setTab] = useState<Tab>('assets');
  return (
    <>
      <PageHeader title={a.title} subtitle={a.subtitle} />
      <div className="tabs" role="tablist">
        {(Object.keys(a.tabs) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {a.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'assets' && <AssetsTab />}
      {tab === 'tickets' && <TicketsTab />}
      {tab === 'contracts' && <ContractsTab />}
    </>
  );
}
