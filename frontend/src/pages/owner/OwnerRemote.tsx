import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  LoadingState,
  useConfirm,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { formatDateTime, formatMoney } from '../../lib/format';
import { ownerApi, ownerPost } from '../../lib/owner';
import {
  PrintRulesEditor,
  type PrintRules,
} from '../../components/PrintRulesEditor';

const r = t.owner.remote;
type Tab = keyof typeof r.tabs;
type Snapshot<T> = { result: T; doneAt: string | null } | undefined;
type RemoteData = {
  hosted: boolean;
  compatible: boolean;
  lastContact: string | null;
  snapshots: Record<string, Snapshot<unknown>>;
  ops: {
    id: string;
    kind: string;
    status: keyof typeof r.status;
    error: string | null;
    createdAt: string;
    doneAt: string | null;
  }[];
};
type Menu = {
  categories: { id: string; name: string; isActive: boolean }[];
  products: {
    id: string;
    name: string;
    categoryId: string;
    isActive: boolean;
    variants: { id: string; name: string; price: number; isActive: boolean }[];
  }[];
};
type Staff = {
  users: {
    id: string;
    displayName: string;
    username: string;
    status: 'ACTIVE' | 'DISABLED';
    roles: string[];
    hasPin: boolean;
    lastLoginAt: string | null;
  }[];
};
type Floor = {
  rooms: {
    id: string;
    name: string;
    kind: keyof typeof r.roomKind;
    isActive: boolean;
    branch: { name: string };
    tables: { id: string; name: string; seats: number; isActive: boolean }[];
  }[];
};
type Settings = {
  orderSettings: Record<string, boolean>;
  printers: {
    id: string;
    name: string;
    kind: string;
    host: string;
    port: number;
    paperWidth: number;
    isActive: boolean;
    station: { name: string } | null;
  }[];
  stations: { id: string; name: string; isActive: boolean }[];
};
type PrinterRow = {
  id: string;
  name: string;
  kind: keyof typeof r.printerKind;
  host: string;
  port: number;
  paperWidth: number;
  isActive: boolean;
  stationId: string | null;
  fallbackPrinterId: string | null;
  lastJob: {
    status: keyof typeof r.jobStatus;
    createdAt: string;
    lastError: string | null;
  } | null;
  failed24h: number;
  unknown24h: number;
  pending: number;
  duplicateAddress: boolean;
};
type Printers = {
  printers: PrinterRow[];
  stations: { id: string; name: string; isActive: boolean }[];
  rules: PrintRules;
  enforced: string[];
};
type Inventory = {
  items: {
    id: string;
    name: string;
    unit: string;
    quantity: number;
    minStock: number;
    low: boolean;
  }[];
};
type Reports = {
  days: { day: string; orders: number; total: number; paid: number }[];
  open: number;
};

const SNAPSHOT: Partial<Record<Tab, string>> = {
  menu: 'snapshot.menu',
  staff: 'snapshot.staff',
  floor: 'snapshot.floor',
  settings: 'snapshot.settings',
  printers: 'snapshot.printers',
  inventory: 'snapshot.inventory',
  reports: 'snapshot.reports',
};

/**
 * Owner → Restoran boshqaruvi: the restaurant's menu, staff, floor, settings, stock
 * and sales as last reported, with small changes sent as audited operations.
 */
export function RemoteSection({ customerId }: { customerId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [tab, setTab] = useState<Tab>('menu');
  const [busy, setBusy] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const data = useQuery({
    queryKey: ['owner', 'remote', customerId],
    queryFn: () => ownerApi<RemoteData>(`/customers/${customerId}/remote`),
    // While the restaurant has work to do, look again soon.
    refetchInterval: (query) =>
      query.state.data?.ops.some(
        (op) => op.status === 'QUEUED' || op.status === 'SENT',
      )
        ? 5_000
        : 60_000,
  });
  if (data.isPending) return <LoadingState />;
  if (!data.data) return null;
  const remote = data.data;
  const send = async (kind: string, payload: object = {}) => {
    setBusy(true);
    try {
      const op = await ownerPost<{ status: string }>(
        `/customers/${customerId}/remote/ops`,
        {
          kind,
          payload,
        },
      );
      toast(op.status === 'DONE' ? r.done : r.sent);
      await client.invalidateQueries({
        queryKey: ['owner', 'remote', customerId],
      });
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };
  const snapshotKind = SNAPSHOT[tab];
  const snapshot = snapshotKind ? remote.snapshots[snapshotKind] : undefined;
  const waiting = snapshotKind
    ? remote.ops.some(
        (op) =>
          op.kind === snapshotKind &&
          (op.status === 'QUEUED' || op.status === 'SENT'),
      )
    : false;

  const body = () => {
    if (tab === 'ops')
      return (
        <ul className="ops-list">
          {remote.ops.map((op) => (
            <li key={op.id} className="ops-item">
              <div className="grow">
                <strong>
                  {(r.kinds as Record<string, string>)[op.kind] ?? op.kind}
                </strong>
                <div className="muted small">
                  {formatDateTime(op.createdAt)}
                  {op.error ? ` · ${op.error}` : ''}
                </div>
              </div>
              <Badge
                tone={
                  op.status === 'DONE'
                    ? 'success'
                    : op.status === 'FAILED'
                      ? 'danger'
                      : 'warning'
                }
              >
                {r.status[op.status]}
              </Badge>
            </li>
          ))}
        </ul>
      );
    if (!snapshot) return <p className="muted">{r.noData}</p>;
    if (tab === 'menu') {
      const menu = snapshot.result as Menu;
      return (
        <div className="stack">
          {menu.categories.map((category) => {
            const products = menu.products.filter(
              (p) => p.categoryId === category.id,
            );
            if (products.length === 0) return null;
            return (
              <details key={category.id}>
                <summary>
                  <strong>{category.name}</strong> ({products.length})
                  {!category.isActive && <Badge> {r.inactive}</Badge>}
                </summary>
                <ul className="ops-list">
                  {products.map((product) => (
                    <li key={product.id} className="ops-item">
                      <div className="grow">
                        <strong>{product.name}</strong>{' '}
                        <Badge tone={product.isActive ? 'success' : 'warning'}>
                          {product.isActive ? r.active : r.inactive}
                        </Badge>
                        {product.variants.map((variant) => (
                          <div key={variant.id} className="toolbar small">
                            <span>{variant.name}:</span>
                            <input
                              className="input"
                              style={{ width: 120 }}
                              inputMode="numeric"
                              aria-label={`${product.name} ${variant.name} ${r.price}`}
                              value={
                                prices[variant.id] ?? String(variant.price)
                              }
                              onChange={(event) =>
                                setPrices({
                                  ...prices,
                                  [variant.id]: event.target.value.replace(
                                    /\D/g,
                                    '',
                                  ),
                                })
                              }
                            />
                            <span className="muted">
                              {formatMoney(variant.price)}
                            </span>
                            {prices[variant.id] !== undefined &&
                              Number(prices[variant.id]) !== variant.price && (
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void send('menu.variant.price', {
                                      variantId: variant.id,
                                      price: Number(prices[variant.id]),
                                    })
                                  }
                                >
                                  {r.savePrice}
                                </Button>
                              )}
                          </div>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void send('menu.product.visibility', {
                            productId: product.id,
                            isActive: !product.isActive,
                          })
                        }
                      >
                        {product.isActive ? r.hide : r.show}
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      );
    }
    if (tab === 'staff') {
      const staff = snapshot.result as Staff;
      return (
        <ul className="ops-list">
          {staff.users.map((user) => (
            <li key={user.id} className="ops-item">
              <div className="grow">
                <strong>{user.displayName}</strong>{' '}
                <span className="muted small">@{user.username}</span>
                <div className="muted small">
                  {user.roles.join(', ')} · {user.hasPin ? r.hasPin : r.noPin} ·{' '}
                  {formatDateTime(user.lastLoginAt)}
                </div>
              </div>
              <Badge tone={user.status === 'ACTIVE' ? 'success' : 'danger'}>
                {user.status === 'ACTIVE' ? r.active : r.inactive}
              </Badge>
              <Button
                size="sm"
                variant={user.status === 'ACTIVE' ? 'danger' : 'primary'}
                disabled={busy}
                onClick={async () => {
                  if (
                    user.status === 'ACTIVE' &&
                    !(await confirm(r.disableConfirm))
                  )
                    return;
                  void send('staff.status', {
                    userId: user.id,
                    status: user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                  });
                }}
              >
                {user.status === 'ACTIVE' ? r.disableUser : r.enableUser}
              </Button>
            </li>
          ))}
        </ul>
      );
    }
    if (tab === 'floor') {
      const floor = snapshot.result as Floor;
      return (
        <div className="stack">
          {floor.rooms.map((room) => (
            <section key={room.id} className="card stack">
              <div className="toolbar">
                <strong className="grow">
                  {room.name} · {room.branch.name}
                </strong>
                <select
                  className="input"
                  value={room.kind}
                  aria-label={room.name}
                  disabled={busy}
                  onChange={(event) =>
                    void send('floor.room', {
                      roomId: room.id,
                      kind: event.target.value,
                    })
                  }
                >
                  {Object.entries(r.roomKind).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void send('floor.room', {
                      roomId: room.id,
                      isActive: !room.isActive,
                    })
                  }
                >
                  {room.isActive ? r.hide : r.show}
                </Button>
              </div>
              <div className="badges">
                {room.tables.map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    className={`badge ${table.isActive ? 'badge-success' : 'badge-neutral'}`}
                    disabled={busy}
                    title={table.isActive ? r.hide : r.show}
                    onClick={() =>
                      void send('floor.table', {
                        tableId: table.id,
                        isActive: !table.isActive,
                      })
                    }
                  >
                    {table.name} ({table.seats})
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      );
    }
    if (tab === 'settings') {
      const settings = snapshot.result as Settings;
      const labels = t.orderSettings.labels as Record<string, string>;
      return (
        <div className="stack">
          <h4 style={{ margin: 0 }}>{r.orderSettings}</h4>
          <div className="check-grid">
            {Object.entries(settings.orderSettings).map(([key, value]) => (
              <Checkbox
                key={key}
                label={labels[key] ?? key}
                checked={value}
                onChange={(on) => void send('settings.orders', { [key]: on })}
              />
            ))}
          </div>
          <h4 style={{ margin: 0 }}>{t.printers.title}</h4>
          <ul className="ops-list">
            {settings.printers.map((printer) => (
              <li key={printer.id} className="ops-item">
                <div className="grow">
                  <strong>{printer.name}</strong>
                  <div className="muted small">
                    {printer.kind} · {printer.host}:{printer.port} ·{' '}
                    {printer.paperWidth} mm
                    {printer.station ? ` · ${printer.station.name}` : ''}
                  </div>
                </div>
                <Badge tone={printer.isActive ? 'success' : 'neutral'}>
                  {printer.isActive ? r.active : r.inactive}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    if (tab === 'printers') {
      const data = snapshot.result as Printers;
      const select = (
        label: string,
        value: string,
        options: [string, string][],
        onChange: (value: string) => void,
      ) => (
        <label>
          {label}{' '}
          <select
            className="input"
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map(([key, text]) => (
              <option key={key} value={key}>
                {text}
              </option>
            ))}
          </select>
        </label>
      );
      return (
        <div className="stack">
          <ul className="ops-list">
            {data.printers.map((printer) => (
              <li key={printer.id} className="ops-item">
                <div className="grow stack" style={{ gap: 4 }}>
                  <div>
                    <strong>{printer.name}</strong>{' '}
                    <Badge>{r.printerKind[printer.kind]}</Badge>{' '}
                    <Badge tone={printer.isActive ? 'success' : 'neutral'}>
                      {printer.isActive ? r.active : r.inactive}
                    </Badge>
                  </div>
                  <div className="muted small">
                    {printer.host}:{printer.port} ·{' '}
                    {printer.lastJob
                      ? r.lastJob
                          .replace(
                            '{status}',
                            r.jobStatus[printer.lastJob.status],
                          )
                          .replace(
                            '{at}',
                            formatDateTime(printer.lastJob.createdAt),
                          )
                      : r.noJobs}
                    {' · '}
                    {r.failed24h.replace(
                      '{n}',
                      String(printer.failed24h),
                    )},{' '}
                    {r.unknown24h.replace('{n}', String(printer.unknown24h))},{' '}
                    {r.pending.replace('{n}', String(printer.pending))}
                  </div>
                  {printer.duplicateAddress && (
                    <small style={{ color: 'var(--danger, #c0392b)' }}>
                      ⚠ {r.duplicateAddress}
                    </small>
                  )}
                  <div className="toolbar small">
                    {select(
                      r.paper,
                      String(printer.paperWidth),
                      [58, 76, 80].map((mm) => [String(mm), `${mm} mm`]),
                      (value) =>
                        void send('printer.update', {
                          printerId: printer.id,
                          paperWidth: Number(value),
                        }),
                    )}
                    {printer.kind === 'KITCHEN' &&
                      select(
                        r.station,
                        printer.stationId ?? '',
                        [
                          ['', r.stationAll],
                          ...data.stations.map((s): [string, string] => [
                            s.id,
                            s.name,
                          ]),
                        ],
                        (value) =>
                          void send('printer.update', {
                            printerId: printer.id,
                            stationId: value || null,
                          }),
                      )}
                    {select(
                      r.fallback,
                      printer.fallbackPrinterId ?? '',
                      [
                        ['', r.fallbackNone],
                        ...data.printers
                          .filter((other) => other.id !== printer.id)
                          .map((other): [string, string] => [
                            other.id,
                            other.name,
                          ]),
                      ],
                      (value) =>
                        void send('printer.update', {
                          printerId: printer.id,
                          fallbackPrinterId: value || null,
                        }),
                    )}
                  </div>
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <Button
                    size="sm"
                    disabled={busy || !printer.isActive}
                    onClick={() =>
                      void send('printer.test', { printerId: printer.id })
                    }
                  >
                    🖨 {r.test}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void send('printer.update', {
                        printerId: printer.id,
                        isActive: !printer.isActive,
                      })
                    }
                  >
                    {printer.isActive ? r.hide : r.show}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <h4 style={{ margin: 0 }}>{t.printRules.title}</h4>
          <PrintRulesEditor
            key={snapshot.doneAt ?? ''}
            rules={data.rules}
            enforced={data.enforced}
            busy={busy}
            onSave={(rules) => void send('print.rules', rules)}
          />
        </div>
      );
    }
    if (tab === 'inventory') {
      const inventory = snapshot.result as Inventory;
      return (
        <ul className="ops-list">
          {inventory.items.map((item) => (
            <li key={item.id} className="ops-item">
              <div className="grow">
                <strong>{item.name}</strong>
                <div className="muted small">
                  {item.quantity} {item.unit} · {r.minStock}: {item.minStock}
                </div>
              </div>
              {item.low && <Badge tone="danger">{r.low}</Badge>}
            </li>
          ))}
        </ul>
      );
    }
    const reports = snapshot.result as Reports;
    return (
      <div className="stack">
        <p className="muted">
          {r.openOrders.replace('{n}', String(reports.open))}
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{r.day}</th>
                <th className="right">{r.orders}</th>
                <th className="right">{r.total}</th>
                <th className="right">{r.paid}</th>
              </tr>
            </thead>
            <tbody>
              {reports.days.map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td className="right">{day.orders}</td>
                  <td className="right">{formatMoney(day.total)}</td>
                  <td className="right">{formatMoney(day.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <section className="card stack">
      <h3 className="section-title">{r.title}</h3>
      <p className="muted small">{r.subtitle}</p>
      {!remote.compatible && <p className="notice">{r.incompatible}</p>}
      <div className="tabs" role="tablist">
        {(Object.keys(r.tabs) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {r.tabs[key]}
          </button>
        ))}
      </div>
      {snapshotKind && (
        <div className="toolbar">
          <Button
            size="sm"
            busy={busy}
            disabled={waiting}
            onClick={() => void send(snapshotKind)}
          >
            ⟳ {r.refresh}
          </Button>
          {waiting && <span className="muted small">{r.waiting}</span>}
          {snapshot?.doneAt && (
            <span className="muted small">
              {r.updatedAt.replace('{at}', formatDateTime(snapshot.doneAt))}
            </span>
          )}
        </div>
      )}
      {body()}
      {element}
    </section>
  );
}
