import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime, formatMoney } from '../../lib/format';
import { ownerApi, ownerPost } from '../../lib/owner';

const d = t.owner.data;

type Tab =
  | 'overview'
  | 'branches'
  | 'devices'
  | 'users'
  | 'roles'
  | 'settings'
  | 'orders';
type Rows = Record<string, unknown>;

function useData<T>(customerId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['owner', 'data', customerId, path],
    queryFn: () => ownerApi<T>(`/customers/${customerId}/data/${path}`),
    enabled,
  });
}

function List({
  children,
  empty,
}: {
  children: React.ReactNode[];
  empty: boolean;
}) {
  if (empty) return <EmptyState title={d.noRows} />;
  return <ul className="ops-list">{children}</ul>;
}

/** Read-only, tenant-scoped browser of a hosted restaurant's data (every read is audited). */
export function OwnerData({
  customerId,
  hosted,
}: {
  customerId: string;
  hosted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  if (!hosted)
    return (
      <section className="card stack">
        <h3 className="section-title">{d.title}</h3>
        <p className="muted small">{d.notHosted}</p>
      </section>
    );
  return (
    <section className="card stack">
      <h3 className="section-title">{d.title}</h3>
      <p className="muted small">{d.hint}</p>
      {!open ? (
        <div>
          <Button onClick={() => setOpen(true)}>{d.open}</Button>
        </div>
      ) : (
        <>
          <nav className="tabs" aria-label={d.title}>
            {(Object.keys(d.tabs) as Tab[]).map((key) => (
              <button
                key={key}
                className={`tab ${tab === key ? 'active' : ''}`}
                onClick={() => setTab(key)}
              >
                {d.tabs[key]}
              </button>
            ))}
          </nav>
          {tab === 'overview' && <Overview customerId={customerId} />}
          {tab === 'branches' && <Branches customerId={customerId} />}
          {tab === 'devices' && <Devices customerId={customerId} />}
          {tab === 'users' && <Users customerId={customerId} />}
          {tab === 'roles' && <Roles customerId={customerId} />}
          {tab === 'settings' && <SettingsView customerId={customerId} />}
          {tab === 'orders' && <Orders customerId={customerId} />}
        </>
      )}
    </section>
  );
}

function Overview({ customerId }: { customerId: string }) {
  const data = useData<Record<string, number>>(customerId, 'overview', true);
  if (data.isPending) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} />;
  return (
    <div className="form-grid">
      {Object.entries(d.counts).map(([key, label]) => (
        <div key={key} className="card">
          <div className="muted small">{label}</div>
          <strong style={{ fontSize: '1.6rem' }}>{data.data[key] ?? 0}</strong>
        </div>
      ))}
    </div>
  );
}

function Branches({ customerId }: { customerId: string }) {
  const data = useData<{ branches: Rows[] }>(customerId, 'branches', true);
  if (data.isPending) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} />;
  return (
    <List empty={data.data.branches.length === 0}>
      {data.data.branches.map((branch) => (
        <li key={String(branch.id)} className="ops-item">
          <div className="grow">
            <strong>{String(branch.name)}</strong>
            <div className="muted small">
              {String(branch.code)} · {String(branch.address ?? '—')} ·{' '}
              {String(branch.phone ?? '—')}
            </div>
          </div>
          <Badge tone={branch.isActive ? 'success' : 'neutral'}>
            {branch.isActive ? t.common.active : '—'}
          </Badge>
        </li>
      ))}
    </List>
  );
}

function Devices({ customerId }: { customerId: string }) {
  const data = useData<{ devices: Rows[] }>(customerId, 'devices', true);
  if (data.isPending) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} />;
  return (
    <List empty={data.data.devices.length === 0}>
      {data.data.devices.map((device) => (
        <li key={String(device.id)} className="ops-item">
          <div className="grow">
            <strong>{String(device.name)}</strong>
            <div className="muted small">
              {String(device.branch)} · {String(device.panel)} ·{' '}
              {String(device.lastIp ?? '—')} · v
              {String(device.appVersion ?? '—')} ·{' '}
              {device.lastSeenAt
                ? formatDateTime(String(device.lastSeenAt))
                : '—'}
            </div>
          </div>
          <Badge tone={device.status === 'ACTIVE' ? 'success' : 'danger'}>
            {String(device.status)}
          </Badge>
        </li>
      ))}
    </List>
  );
}

function Users({ customerId }: { customerId: string }) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [q, setQ] = useState('');
  const data = useData<{ users: Rows[] }>(
    customerId,
    `users${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    true,
  );
  const change = async (userId: string, status: 'ACTIVE' | 'DISABLED') => {
    if (status === 'DISABLED' && !(await confirm(d.suspendAsk))) return;
    try {
      await ownerPost(`/customers/${customerId}/data/users/${userId}/status`, {
        status,
      });
      await data.refetch();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <div className="stack">
      {element}
      <TextField
        label={t.common.search}
        placeholder={d.search}
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      {data.isPending ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <List empty={data.data.users.length === 0}>
          {data.data.users.map((user) => (
            <li key={String(user.id)} className="ops-item">
              <div className="grow">
                <strong>{String(user.displayName)}</strong>{' '}
                <span className="muted small">@{String(user.username)}</span>
                <div className="muted small">
                  {(user.roles as string[]).join(', ')} · {d.mfa}:{' '}
                  {user.mfa ? '✓' : '—'} ·{' '}
                  {user.lastLoginAt
                    ? formatDateTime(String(user.lastLoginAt))
                    : '—'}
                </div>
              </div>
              <Badge tone={user.status === 'ACTIVE' ? 'success' : 'danger'}>
                {String(user.status)}
              </Badge>
              {user.status === 'ACTIVE' ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void change(String(user.id), 'DISABLED')}
                >
                  {d.suspend}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void change(String(user.id), 'ACTIVE')}
                >
                  {d.restore}
                </Button>
              )}
            </li>
          ))}
        </List>
      )}
    </div>
  );
}

function Roles({ customerId }: { customerId: string }) {
  const data = useData<{ roles: Rows[] }>(customerId, 'roles', true);
  if (data.isPending) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} />;
  return (
    <List empty={data.data.roles.length === 0}>
      {data.data.roles.map((role) => (
        <li key={String(role.id)} className="ops-item">
          <div className="grow">
            <strong>{String(role.name)}</strong>{' '}
            <span className="muted small">
              {String(role.systemKey ?? '')} · {Number(role.users)} ·{' '}
              {(role.permissions as string[]).length}
            </span>
            <details>
              <summary className="muted small">
                {(role.permissions as string[]).length}
              </summary>
              <div className="muted small">
                {(role.permissions as string[]).join(', ')}
              </div>
            </details>
          </div>
        </li>
      ))}
    </List>
  );
}

function SettingsView({ customerId }: { customerId: string }) {
  const data = useData<{
    profile: {
      legalName: string | null;
      taxId: string | null;
      phone: string | null;
      serviceChargeBp: number;
      orderSettings: Record<string, boolean>;
    } | null;
    delegated: {
      feature: string;
      role: string;
      enabled: boolean | null;
      params: unknown;
    }[];
    receiptTemplates: {
      id: string;
      name: string;
      kind: string;
      widthMm: number;
      assignments: { type: string; targetId: string }[];
    }[];
  }>(customerId, 'settings', true);
  if (data.isPending) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} />;
  const { profile, delegated, receiptTemplates } = data.data;
  return (
    <div className="stack">
      {profile && (
        <>
          <strong>{d.workflow}</strong>
          <div className="check-grid">
            {Object.entries(profile.orderSettings).map(([key, value]) => (
              <span key={key} className="small">
                {value ? '✓' : '—'} {key}
              </span>
            ))}
          </div>
        </>
      )}
      <strong>{d.delegated}</strong>
      {delegated.length === 0 ? (
        <p className="muted small">{d.noRows}</p>
      ) : (
        <ul className="plain-list small">
          {delegated.map((row) => (
            <li key={`${row.feature}|${row.role}`}>
              {row.feature} · {row.role} ·{' '}
              {row.enabled === null ? '' : row.enabled ? '✓' : '✗'}{' '}
              {row.params ? JSON.stringify(row.params) : ''}
            </li>
          ))}
        </ul>
      )}
      <strong>{d.templates}</strong>
      {receiptTemplates.length === 0 ? (
        <p className="muted small">{d.noRows}</p>
      ) : (
        <ul className="plain-list small">
          {receiptTemplates.map((template) => (
            <li key={template.id}>
              {template.name} · {template.kind} · {template.widthMm} mm ·{' '}
              {template.assignments.length}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Orders({ customerId }: { customerId: string }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  const data = useData<{ orders: Rows[] }>(
    customerId,
    `orders${query.size ? `?${query.toString()}` : ''}`,
    true,
  );
  return (
    <div className="stack">
      <div className="form-grid">
        <TextField
          label={t.common.search}
          placeholder={d.search}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <SelectField
          label={t.common.status}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">{d.allStatuses}</option>
          {Object.entries(t.orders.statuses).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      {data.isPending ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <List empty={data.data.orders.length === 0}>
          {data.data.orders.map((order) => (
            <li key={String(order.id)} className="ops-item">
              <div className="grow">
                <button
                  className="text-link"
                  onClick={() => setSelected(String(order.id))}
                >
                  №{String(order.number).padStart(3, '0')}
                </button>{' '}
                <span className="muted small">
                  {String(order.branch)} · {String(order.table ?? '—')} ·{' '}
                  {formatDateTime(String(order.createdAt))}
                </span>
              </div>
              <Badge>
                {t.orders.statuses[
                  order.status as keyof typeof t.orders.statuses
                ] ?? String(order.status)}
              </Badge>
              <strong>{formatMoney(Number(order.total))}</strong>
            </li>
          ))}
        </List>
      )}
      {selected && (
        <OrderDialog
          customerId={customerId}
          orderId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function OrderDialog({
  customerId,
  orderId,
  onClose,
}: {
  customerId: string;
  orderId: string;
  onClose: () => void;
}) {
  const data = useData<{
    number: number;
    status: string;
    total: number;
    paidTotal: number;
    discountTotal: number;
    items: {
      name: string;
      quantity: number;
      lineTotal: number;
      status: string;
    }[];
    payments: { method: string; amount: number; createdAt: string }[];
    events: { type: string; createdAt: string }[];
  }>(customerId, `orders/${orderId}`, true);
  return (
    <Dialog open title={d.orderDetail} onClose={onClose} wide>
      {data.isPending ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <div className="stack">
          <strong>
            №{String(data.data.number).padStart(3, '0')} ·{' '}
            {formatMoney(data.data.total)}
          </strong>
          <ul className="plain-list small">
            {data.data.items.map((item, index) => (
              <li key={index}>
                {item.quantity} × {item.name} — {formatMoney(item.lineTotal)}{' '}
                {item.status === 'CANCELLED' ? '✗' : ''}
              </li>
            ))}
          </ul>
          <ul className="plain-list small">
            {data.data.payments.map((payment, index) => (
              <li key={index}>
                {payment.method} · {formatMoney(payment.amount)} ·{' '}
                {formatDateTime(payment.createdAt)}
              </li>
            ))}
          </ul>
          <ul className="plain-list small muted">
            {data.data.events.map((event, index) => (
              <li key={index}>
                {formatDateTime(event.createdAt)} · {event.type}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
