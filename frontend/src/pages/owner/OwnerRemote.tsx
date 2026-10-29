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
  PartialRestorePanel,
  PartialResultTable,
  type PartialResult,
} from '../../components/PartialRestore';
import {
  PrintRulesEditor,
  type PrintRules,
} from '../../components/PrintRulesEditor';

const r = t.owner.remote;
type Tab = keyof typeof r.tabs;
type Snapshot<T> = { result: T; doneAt: string | null } | undefined;
type Counted = { total: number; online: number };
type Monitoring = {
  printing?: { failed24h: number; unknown24h: number; pending: number };
  panels?: Partial<Record<keyof typeof r.mon.panel, Counted>>;
  backup?: {
    lastAt: string | null;
    ok: boolean | null;
    lastName: string | null;
    count: number;
  };
};
type BackupRow = {
  name: string;
  kind: string;
  createdAt: string;
  bytes: number;
  totalRows: number | null;
  verified: boolean | null;
};
type Backups = {
  available: boolean;
  canRestore: boolean;
  backups: BackupRow[];
  kept: string[];
};
type RemoteData = {
  hosted: boolean;
  compatible: boolean;
  backups?: boolean;
  restore?: boolean;
  // Qisman tiklash (newer restaurant servers) and its newest finished run.
  partialRestore?: boolean;
  partial?: {
    payload: { name?: string; dryRun?: boolean };
    result: PartialResult | null;
    doneAt: string | null;
  } | null;
  monitoring?: Monitoring | null;
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
  backups: 'snapshot.backups',
};

/** "fastfood_before_20261029170954138" → the date and time it was kept. */
const keptAt = (name: string) => {
  const digits = name.replace('fastfood_before_', '');
  const at = new Date(
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`,
  );
  return Number.isNaN(at.getTime()) ? name : formatDateTime(at.toISOString());
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
  // A restore or rollback waiting for the typed confirmation word.
  const [partialFor, setPartialFor] = useState<{
    name: string;
    at: string;
    asked: string;
  } | null>(null);
  const [pendingRestore, setPendingRestore] = useState<
    | { kind: 'backup.restore'; name: string; title: string }
    | { kind: 'backup.rollback'; name: string; title: string }
    | null
  >(null);
  const [word, setWord] = useState('');
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

  const restorePanel = pendingRestore && (
    <div
      className="card stack"
      style={{ borderColor: 'var(--danger, #c0392b)' }}
    >
      <strong>{pendingRestore.title}</strong>
      <p className="small">{r.bk.restoreWarn}</p>
      <label className="stack" style={{ gap: 4 }}>
        <span className="small">{r.bk.typeWord}</span>
        <input
          className="input"
          value={word}
          autoComplete="off"
          onChange={(event) => setWord(event.target.value)}
        />
      </label>
      <div className="toolbar">
        <Button
          variant="danger"
          busy={busy}
          disabled={word.trim() !== 'TIKLASH'}
          onClick={async () => {
            await send(
              pendingRestore.kind,
              pendingRestore.kind === 'backup.restore'
                ? { name: pendingRestore.name, confirm: 'TIKLASH' }
                : { database: pendingRestore.name, confirm: 'TIKLASH' },
            );
            setPendingRestore(null);
            setWord('');
          }}
        >
          {r.bk.confirmRestore}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setPendingRestore(null);
            setWord('');
          }}
        >
          {r.bk.cancel}
        </Button>
      </div>
    </div>
  );

  const body = () => {
    if (tab === 'monitoring') {
      const m = remote.monitoring;
      const online =
        remote.lastContact !== null &&
        Date.now() - new Date(remote.lastContact).getTime() < 5 * 60_000;
      if (remote.hosted) return <p className="muted">{r.mon.hosted}</p>;
      const printing = m?.printing;
      const printingBad = printing
        ? printing.failed24h + printing.unknown24h > 0
        : false;
      const backupBad = m?.backup
        ? m.backup.ok === false || !m.backup.lastAt
        : false;
      return (
        <div className="stack">
          <div>
            <Badge tone={online ? 'success' : 'danger'}>
              {online ? r.mon.online : r.mon.offline}
            </Badge>{' '}
            <span className="muted small">
              {remote.lastContact
                ? r.mon.lastContact.replace(
                    '{at}',
                    formatDateTime(remote.lastContact),
                  )
                : r.mon.never}
            </span>
          </div>
          {!m?.printing ? (
            <p className="muted">{r.mon.noFacts}</p>
          ) : (
            <ul className="ops-list">
              <li className="ops-item">
                <div className="grow">
                  <strong>{r.mon.printing}</strong>
                  <div className="muted small">
                    {r.mon.printingLine
                      .replace('{failed}', String(m.printing.failed24h))
                      .replace('{unknown}', String(m.printing.unknown24h))
                      .replace('{pending}', String(m.printing.pending))}
                  </div>
                </div>
                <Badge tone={printingBad ? 'warning' : 'success'}>
                  {printingBad ? r.mon.attention : r.mon.allGood}
                </Badge>
              </li>
              <li className="ops-item">
                <div className="grow">
                  <strong>{r.mon.panels}</strong>
                  {(
                    Object.keys(r.mon.panel) as (keyof typeof r.mon.panel)[]
                  ).map((panel) => {
                    const counted = m.panels?.[panel];
                    if (!counted || counted.total === 0) return null;
                    return (
                      <div key={panel} className="muted small">
                        {r.mon.panel[panel]}:{' '}
                        {r.mon.onlineOf
                          .replace('{online}', String(counted.online))
                          .replace('{total}', String(counted.total))}
                      </div>
                    );
                  })}
                </div>
              </li>
              <li className="ops-item">
                <div className="grow">
                  <strong>{r.mon.backup}</strong>
                  <div className="muted small">
                    {m.backup?.lastAt
                      ? formatDateTime(m.backup.lastAt)
                      : r.mon.backupNone}
                  </div>
                </div>
                {m.backup && (
                  <Badge tone={backupBad ? 'danger' : 'success'}>
                    {backupBad ? r.mon.backupFailed : r.mon.backupOk}
                  </Badge>
                )}
              </li>
            </ul>
          )}
        </div>
      );
    }
    if (tab === 'backups') {
      if (remote.hosted) return <p className="muted">{r.bk.hosted}</p>;
      if (!remote.backups) return <p className="notice">{r.bk.needsUpdate}</p>;
      const data = snapshot?.result as Backups | undefined;
      return (
        <div className="stack">
          <p className="muted small">{r.bk.hint}</p>
          <p className="muted small">{r.bk.partialNote}</p>
          {!remote.restore && (
            <p className="notice">{r.bk.restoreUnsupported}</p>
          )}
          <div>
            <Button
              size="sm"
              busy={busy}
              onClick={() => void send('backup.create')}
            >
              {r.bk.createNow}
            </Button>
          </div>
          {restorePanel}
          {partialFor && (
            <PartialRestorePanel
              title={t.partialRestore.title.replace(
                '{at}',
                formatDateTime(partialFor.at),
              )}
              busy={busy}
              preview={
                remote.partial?.payload.name === partialFor.name &&
                remote.partial.payload.dryRun !== false &&
                (remote.partial.doneAt ?? '') > partialFor.asked
                  ? remote.partial.result
                  : null
              }
              onClose={() => setPartialFor(null)}
              onPreview={(groups) => {
                setPartialFor({
                  ...partialFor,
                  asked: new Date().toISOString(),
                });
                void send('backup.partial', {
                  name: partialFor.name,
                  groups,
                  dryRun: true,
                });
              }}
              onRestore={(groups) => {
                void send('backup.partial', {
                  name: partialFor.name,
                  groups,
                  dryRun: false,
                  confirm: 'TIKLASH',
                });
                setPartialFor(null);
              }}
            />
          )}
          {partialFor &&
            remote.ops.some(
              (op) =>
                op.kind === 'backup.partial' &&
                (op.status === 'QUEUED' || op.status === 'SENT'),
            ) && (
              <p className="muted small">{t.partialRestore.previewWaiting}</p>
            )}
          {!partialFor &&
            remote.partial?.result &&
            remote.partial.payload.dryRun === false && (
              <div className="card stack">
                <strong>
                  {t.partialRestore.last.replace(
                    '{at}',
                    formatDateTime(remote.partial.doneAt ?? ''),
                  )}
                </strong>
                <PartialResultTable result={remote.partial.result} />
              </div>
            )}
          {!data ? (
            <p className="muted">{r.noData}</p>
          ) : data.backups.length === 0 ? (
            <p className="muted">{r.bk.none}</p>
          ) : (
            <ul className="ops-list">
              {data.backups.map((row) => (
                <li key={row.name} className="ops-item">
                  <div className="grow">
                    <strong>{formatDateTime(row.createdAt)}</strong>{' '}
                    <Badge>{r.bk.kinds[row.kind] ?? row.kind}</Badge>{' '}
                    <Badge
                      tone={
                        row.verified === true
                          ? 'success'
                          : row.verified === false
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {row.verified === true
                        ? r.bk.verified
                        : row.verified === false
                          ? r.bk.failed
                          : r.bk.notVerified}
                    </Badge>
                    <div className="muted small">
                      {r.bk.size.replace(
                        '{mb}',
                        (row.bytes / 1024 / 1024).toFixed(1),
                      )}
                      {row.totalRows !== null &&
                        ` · ${r.bk.rows.replace('{n}', String(row.totalRows))}`}
                    </div>
                  </div>
                  <div className="toolbar small">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void send('backup.verify', { name: row.name })
                      }
                    >
                      {r.bk.verify}
                    </Button>
                    {remote.partialRestore && row.verified !== false && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setPartialFor({
                            name: row.name,
                            at: row.createdAt,
                            asked: new Date().toISOString(),
                          })
                        }
                      >
                        {t.partialRestore.button}
                      </Button>
                    )}
                    {remote.restore &&
                      data.canRestore &&
                      row.verified !== false && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            setWord('');
                            setPendingRestore({
                              kind: 'backup.restore',
                              name: row.name,
                              title: r.bk.restoreTitle.replace(
                                '{at}',
                                formatDateTime(row.createdAt),
                              ),
                            });
                          }}
                        >
                          {r.bk.restore}
                        </Button>
                      )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data && data.kept.length > 0 && (
            <>
              <h4 style={{ margin: 0 }}>{r.bk.kept}</h4>
              <p className="muted small">{r.bk.keptHint}</p>
              <ul className="ops-list">
                {data.kept.map((name) => (
                  <li key={name} className="ops-item">
                    <div className="grow">{keptAt(name)}</div>
                    {remote.restore && data.canRestore && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setWord('');
                          setPendingRestore({
                            kind: 'backup.rollback',
                            name,
                            title: r.bk.rollbackTitle.replace(
                              '{name}',
                              keptAt(name),
                            ),
                          });
                        }}
                      >
                        {r.bk.rollback}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      );
    }
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
            printers={data.printers}
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
