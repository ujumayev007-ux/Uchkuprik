import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import { useBranches } from '../components/AppShell';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

export type StockItem = {
  id: string;
  name: string;
  sku: string | null;
  baseUnit: 'G' | 'ML' | 'PCS';
  unitLabel: string;
  minStock: string;
  isActive: boolean;
  units: { name: string; factor: string }[];
  quantity: string;
  low: boolean;
  avgCost?: string;
  value?: number;
};

export function useStockItems(enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'items'],
    queryFn: () =>
      api<{ items: StockItem[] }>('/inventory/items').then(
        (data) => data.items,
      ),
    enabled,
  });
}

const qty = (value: string) =>
  Number(value)
    .toLocaleString('uz-UZ', { maximumFractionDigits: 3 })
    .replace(/,/g, ' ');

function ItemForm({
  item,
  onDone,
}: {
  item: StockItem | null;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: item?.name ?? '',
    sku: item?.sku ?? '',
    baseUnit: item?.baseUnit ?? ('G' as const),
    minStock: item?.minStock ?? '0',
    isActive: item?.isActive ?? true,
    units: item?.units ?? [],
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          ...form,
          sku: form.sku.trim() || null,
          units: form.units.filter((unit) => unit.name.trim()),
        };
        try {
          if (item) await patch(`/inventory/items/${item.id}`, body);
          else await post('/inventory/items', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <TextField
          label={t.common.name}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
        <TextField
          label={`SKU (${t.common.optional})`}
          value={form.sku}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
        />
        <SelectField
          label={t.inventory.baseUnit}
          value={form.baseUnit}
          onChange={(e) =>
            setForm({
              ...form,
              baseUnit: e.target.value as StockItem['baseUnit'],
            })
          }
        >
          {(['G', 'ML', 'PCS'] as const).map((unit) => (
            <option key={unit} value={unit}>
              {t.inventory.baseUnits[unit]}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t.inventory.minStock}
          inputMode="decimal"
          value={form.minStock}
          onChange={(e) =>
            setForm({ ...form, minStock: e.target.value.replace(',', '.') })
          }
        />
      </div>
      <fieldset>
        <legend>{t.inventory.units}</legend>
        <div className="variant-list">
          {form.units.map((unit, index) => (
            <div key={index} className="variant-row">
              <TextField
                label={t.inventory.unitName}
                value={unit.name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    units: form.units.map((u, i) =>
                      i === index ? { ...u, name: e.target.value } : u,
                    ),
                  })
                }
              />
              <TextField
                label={`${t.inventory.unitFactor} (${t.inventory.baseUnits[form.baseUnit]})`}
                inputMode="decimal"
                value={unit.factor}
                onChange={(e) =>
                  setForm({
                    ...form,
                    units: form.units.map((u, i) =>
                      i === index
                        ? { ...u, factor: e.target.value.replace(',', '.') }
                        : u,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setForm({
                    ...form,
                    units: form.units.filter((_, i) => i !== index),
                  })
                }
              >
                {t.menu.removeVariant}
              </button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          onClick={() =>
            setForm({
              ...form,
              units: [...form.units, { name: '', factor: '' }],
            })
          }
        >
          + {t.inventory.addUnit}
        </Button>
      </fieldset>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function MovementForm({
  items,
  mode,
  onDone,
}: {
  items: StockItem[];
  mode: 'WASTE' | 'ADJUSTMENT' | 'STOCKTAKE' | 'TRANSFER';
  onDone: () => void;
}) {
  const { data: me } = useMe();
  const branches = useBranches();
  const [lines, setLines] = useState<
    { stockItemId: string; quantity: string }[]
  >([{ stockItemId: items[0]?.id ?? '', quantity: '' }]);
  const [reason, setReason] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const targets = (branches.data ?? []).filter(
    (branch) => branch.id !== me?.activeBranchId && branch.isActive,
  );
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const valid = lines.filter((line) => line.stockItemId && line.quantity);
        try {
          if (mode === 'STOCKTAKE')
            await post('/inventory/stocktakes', {
              counts: valid.map((line) => ({
                stockItemId: line.stockItemId,
                counted: line.quantity,
              })),
            });
          else if (mode === 'TRANSFER')
            await post('/inventory/transfers', {
              toBranchId: toBranchId || targets[0]?.id,
              lines: valid,
              note: reason || null,
            });
          else
            await post('/inventory/adjustments', {
              type: mode,
              reason,
              lines: valid,
            });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      {mode === 'STOCKTAKE' && (
        <p className="muted">{t.inventory.stocktakeHint}</p>
      )}
      {mode === 'TRANSFER' && (
        <SelectField
          label={t.inventory.targetBranch}
          value={toBranchId || targets[0]?.id || ''}
          onChange={(e) => setToBranchId(e.target.value)}
          required
        >
          {targets.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </SelectField>
      )}
      <div className="variant-list">
        {lines.map((line, index) => {
          const item = items.find(
            (candidate) => candidate.id === line.stockItemId,
          );
          return (
            <div key={index} className="variant-row">
              <SelectField
                label={t.inventory.item}
                value={line.stockItemId}
                onChange={(e) =>
                  setLines(
                    lines.map((l, i) =>
                      i === index ? { ...l, stockItemId: e.target.value } : l,
                    ),
                  )
                }
              >
                {items.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({qty(candidate.quantity)}{' '}
                    {candidate.unitLabel})
                  </option>
                ))}
              </SelectField>
              <TextField
                label={`${mode === 'STOCKTAKE' ? t.inventory.counted : t.pos.quantity} (${item?.unitLabel ?? ''})`}
                inputMode="decimal"
                value={line.quantity}
                onChange={(e) =>
                  setLines(
                    lines.map((l, i) =>
                      i === index
                        ? { ...l, quantity: e.target.value.replace(',', '.') }
                        : l,
                    ),
                  )
                }
                required
              />
              {lines.length > 1 && (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                >
                  {t.menu.removeVariant}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Button
        size="sm"
        onClick={() =>
          setLines([
            ...lines,
            { stockItemId: items[0]?.id ?? '', quantity: '' },
          ])
        }
      >
        + {t.inventory.addLine}
      </Button>
      {mode !== 'STOCKTAKE' && (
        <TextField
          label={t.inventory.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={mode === 'TRANSFER' ? 0 : 3}
          required={mode !== 'TRANSFER'}
        />
      )}
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function StockTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const items = useStockItems();
  const alerts = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () =>
      api<{
        alerts: {
          stockItemId: string;
          name: string;
          unitLabel: string;
          quantity: string;
          minStock: string;
          suggestedOrder: string;
        }[];
      }>('/inventory/alerts').then((data) => data.alerts),
  });
  const [dialog, setDialog] = useState<
    | { kind: 'item'; item: StockItem | null }
    | { kind: 'WASTE' | 'ADJUSTMENT' | 'STOCKTAKE' | 'TRANSFER' }
    | null
  >(null);
  const manage = can(me, 'inventory.manage');
  const done = async () => {
    setDialog(null);
    toast(t.common.saved);
    await client.invalidateQueries({ queryKey: ['inventory'] });
  };
  if (items.isPending) return <LoadingState />;
  if (items.error)
    return (
      <ErrorState error={items.error} onRetry={() => void items.refetch()} />
    );
  return (
    <div className="stack">
      {manage && (
        <div className="toolbar">
          <Button
            variant="primary"
            onClick={() => setDialog({ kind: 'item', item: null })}
          >
            + {t.inventory.addItem}
          </Button>
          <Button
            disabled={items.data.length === 0}
            onClick={() => setDialog({ kind: 'WASTE' })}
          >
            {t.inventory.waste}
          </Button>
          <Button
            disabled={items.data.length === 0}
            onClick={() => setDialog({ kind: 'ADJUSTMENT' })}
          >
            {t.inventory.adjust}
          </Button>
          <Button
            disabled={items.data.length === 0}
            onClick={() => setDialog({ kind: 'STOCKTAKE' })}
          >
            {t.inventory.stocktake}
          </Button>
          <Button
            disabled={items.data.length === 0}
            onClick={() => setDialog({ kind: 'TRANSFER' })}
          >
            {t.inventory.transfer}
          </Button>
        </div>
      )}
      {alerts.data && alerts.data.length > 0 && (
        <section className="card alert-card">
          <h2>{t.inventory.alerts}</h2>
          <ul className="plain-list">
            {alerts.data.map((alert) => (
              <li key={alert.stockItemId}>
                <strong>{alert.name}</strong>: {qty(alert.quantity)} /{' '}
                {qty(alert.minStock)} {alert.unitLabel} ·{' '}
                {t.inventory.suggested}: {qty(alert.suggestedOrder)}{' '}
                {alert.unitLabel}
              </li>
            ))}
          </ul>
        </section>
      )}
      {items.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.inventory.item}</th>
                <th className="right">{t.inventory.quantity}</th>
                <th className="right">{t.inventory.minStock}</th>
                {items.data[0]?.avgCost !== undefined && (
                  <>
                    <th className="right">{t.inventory.avgCost}</th>
                    <th className="right">{t.inventory.value}</th>
                  </>
                )}
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {items.data.map((item) => (
                <tr
                  key={item.id}
                  className={item.isActive ? '' : 'is-inactive'}
                >
                  <td>
                    <strong>{item.name}</strong>{' '}
                    {item.low && (
                      <Badge tone="warning">{t.inventory.low}</Badge>
                    )}
                    {item.units.length > 0 && (
                      <small className="muted block">
                        {item.units
                          .map(
                            (unit) =>
                              `${unit.name} = ${qty(unit.factor)} ${item.unitLabel}`,
                          )
                          .join(' · ')}
                      </small>
                    )}
                  </td>
                  <td className="right nowrap">
                    {qty(item.quantity)} {item.unitLabel}
                  </td>
                  <td className="right nowrap">
                    {qty(item.minStock)} {item.unitLabel}
                  </td>
                  {item.avgCost !== undefined && (
                    <>
                      <td className="right nowrap">
                        {Number(item.avgCost).toLocaleString('uz-UZ', {
                          maximumFractionDigits: 2,
                        })}{' '}
                        / {item.unitLabel}
                      </td>
                      <td className="right nowrap">
                        {formatMoney(item.value ?? 0)}
                      </td>
                    </>
                  )}
                  {manage && (
                    <td className="right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDialog({ kind: 'item', item })}
                      >
                        {t.common.edit}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={dialog !== null}
        wide
        title={
          dialog?.kind === 'item'
            ? dialog.item
              ? t.inventory.editItem
              : t.inventory.addItem
            : dialog?.kind === 'WASTE'
              ? t.inventory.waste
              : dialog?.kind === 'ADJUSTMENT'
                ? t.inventory.adjust
                : dialog?.kind === 'TRANSFER'
                  ? t.inventory.transfer
                  : t.inventory.stocktake
        }
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'item' && (
          <ItemForm item={dialog.item} onDone={done} />
        )}
        {dialog && dialog.kind !== 'item' && (
          <MovementForm
            items={items.data.filter((item) => item.isActive)}
            mode={dialog.kind}
            onDone={done}
          />
        )}
      </Dialog>
    </div>
  );
}

type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  taxId: string | null;
  note: string | null;
  isActive: boolean;
  purchased?: number;
  paid?: number;
  debt?: number;
};
type Purchase = {
  id: string;
  supplierId: string;
  supplier: string;
  status: 'DRAFT' | 'RECEIVED' | 'CANCELLED';
  invoiceNo: string | null;
  total: number;
  createdAt: string;
  receivedAt: string | null;
  lines: {
    stockItemId: string;
    quantity: string;
    unitName: string;
    unitPrice: number;
    lineTotal: number;
  }[];
};

function useSuppliers() {
  return useQuery({
    queryKey: ['inventory', 'suppliers'],
    queryFn: () =>
      api<{ suppliers: Supplier[] }>('/suppliers').then(
        (data) => data.suppliers,
      ),
  });
}

function PurchaseForm({ onDone }: { onDone: () => void }) {
  const items = useStockItems();
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lines, setLines] = useState<
    {
      stockItemId: string;
      quantity: string;
      unitName: string;
      unitPrice: number | null;
    }[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const list = (items.data ?? []).filter((item) => item.isActive);
  const unitsFor = (id: string) => {
    const item = list.find((candidate) => candidate.id === id);
    return item ? [item.unitLabel, ...item.units.map((unit) => unit.name)] : [];
  };
  const total = lines.reduce(
    (sum, line) =>
      sum + Math.round(Number(line.quantity || 0) * (line.unitPrice ?? 0)),
    0,
  );
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/purchases', {
            supplierId: supplierId || suppliers.data?.[0]?.id,
            invoiceNo: invoiceNo.trim() || null,
            lines: lines.map((line) => ({
              ...line,
              unitPrice: line.unitPrice ?? 0,
            })),
          });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <SelectField
          label={t.inventory.supplier}
          value={supplierId || suppliers.data?.[0]?.id || ''}
          onChange={(e) => setSupplierId(e.target.value)}
          required
        >
          {(suppliers.data ?? [])
            .filter((supplier) => supplier.isActive)
            .map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
        </SelectField>
        <TextField
          label={`${t.inventory.invoiceNo} (${t.common.optional})`}
          value={invoiceNo}
          onChange={(e) => setInvoiceNo(e.target.value)}
        />
      </div>
      <div className="variant-list">
        {lines.map((line, index) => (
          <div key={index} className="purchase-row">
            <SelectField
              label={t.inventory.item}
              value={line.stockItemId}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index
                      ? {
                          ...l,
                          stockItemId: e.target.value,
                          unitName: unitsFor(e.target.value)[0] ?? '',
                        }
                      : l,
                  ),
                )
              }
            >
              {list.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t.pos.quantity}
              inputMode="decimal"
              value={line.quantity}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index
                      ? { ...l, quantity: e.target.value.replace(',', '.') }
                      : l,
                  ),
                )
              }
              required
            />
            <SelectField
              label={t.inventory.unit}
              value={line.unitName}
              onChange={(e) =>
                setLines(
                  lines.map((l, i) =>
                    i === index ? { ...l, unitName: e.target.value } : l,
                  ),
                )
              }
            >
              {unitsFor(line.stockItemId).map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </SelectField>
            <MoneyField
              label={`${t.inventory.unitPrice} (${t.menu.sum})`}
              value={line.unitPrice}
              onChange={(unitPrice) =>
                setLines(
                  lines.map((l, i) => (i === index ? { ...l, unitPrice } : l)),
                )
              }
              required
            />
          </div>
        ))}
      </div>
      <Button
        size="sm"
        disabled={list.length === 0}
        onClick={() =>
          setLines([
            ...lines,
            {
              stockItemId: list[0]!.id,
              quantity: '',
              unitName: unitsFor(list[0]!.id)[0] ?? '',
              unitPrice: null,
            },
          ])
        }
      >
        + {t.inventory.addLine}
      </Button>
      <p className="cart-total">
        <span>{t.pos.total}</span>
        <strong>{formatMoney(total)}</strong>
      </p>
      <FormError error={error} />
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={lines.length === 0}
        >
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function PurchasesTab() {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [creating, setCreating] = useState(false);
  const purchases = useQuery({
    queryKey: ['inventory', 'purchases'],
    queryFn: () =>
      api<{ purchases: Purchase[] }>('/purchases').then(
        (data) => data.purchases,
      ),
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['inventory'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setCreating(true)}>
          + {t.inventory.newPurchase}
        </Button>
      </div>
      {purchases.isPending ? (
        <LoadingState />
      ) : purchases.error ? (
        <ErrorState error={purchases.error} />
      ) : purchases.data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.orders.time}</th>
                <th>{t.inventory.supplier}</th>
                <th>{t.inventory.invoiceNo}</th>
                <th>{t.common.status}</th>
                <th className="right">{t.pos.total}</th>
                <th className="right">{t.common.actions}</th>
              </tr>
            </thead>
            <tbody>
              {purchases.data.map((purchase) => (
                <tr key={purchase.id}>
                  <td>{formatDateTime(purchase.createdAt)}</td>
                  <td>{purchase.supplier}</td>
                  <td>{purchase.invoiceNo ?? '—'}</td>
                  <td>
                    <Badge
                      tone={
                        purchase.status === 'RECEIVED'
                          ? 'success'
                          : purchase.status === 'CANCELLED'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {t.inventory.purchaseStatuses[purchase.status]}
                    </Badge>
                  </td>
                  <td className="right nowrap">
                    {formatMoney(purchase.total)}
                  </td>
                  <td className="right">
                    {purchase.status === 'DRAFT' && (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={async () => {
                            if (await confirm(t.inventory.receiveConfirm))
                              await act(() =>
                                post(`/purchases/${purchase.id}/receive`),
                              );
                          }}
                        >
                          {t.inventory.receive}
                        </Button>{' '}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void act(() =>
                              post(`/purchases/${purchase.id}/cancel`),
                            )
                          }
                        >
                          {t.common.cancel}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={creating}
        wide
        title={t.inventory.newPurchase}
        onClose={() => setCreating(false)}
      >
        {creating && (
          <PurchaseForm
            onDone={async () => {
              setCreating(false);
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['inventory'] });
            }}
          />
        )}
      </Dialog>
      {confirmElement}
    </div>
  );
}

function SuppliersTab() {
  const client = useQueryClient();
  const toast = useToast();
  const suppliers = useSuppliers();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [paying, setPaying] = useState<Supplier | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['inventory', 'suppliers'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  return (
    <div className="stack">
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(() =>
            post('/suppliers', { name, phone: phone.trim() || null }),
          ).then(() => {
            setName('');
            setPhone('');
          });
        }}
      >
        <TextField
          label={t.common.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          required
        />
        <TextField
          label={`${t.common.phone} (${t.common.optional})`}
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Button type="submit" variant="primary">
          + {t.inventory.addSupplier}
        </Button>
      </form>
      {suppliers.data && suppliers.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.inventory.supplier}</th>
                <th>{t.common.phone}</th>
                <th className="right">{t.inventory.purchased}</th>
                <th className="right">{t.inventory.paid}</th>
                <th className="right">{t.inventory.debt}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suppliers.data.map((supplier) => (
                <tr key={supplier.id}>
                  <td>
                    <strong>{supplier.name}</strong>
                  </td>
                  <td>{supplier.phone ?? '—'}</td>
                  <td className="right">
                    {supplier.purchased === undefined
                      ? '—'
                      : formatMoney(supplier.purchased)}
                  </td>
                  <td className="right">
                    {supplier.paid === undefined
                      ? '—'
                      : formatMoney(supplier.paid)}
                  </td>
                  <td className="right">
                    {supplier.debt === undefined ? (
                      '—'
                    ) : (
                      <strong
                        className={supplier.debt > 0 ? 'danger-text' : ''}
                      >
                        {formatMoney(supplier.debt)}
                      </strong>
                    )}
                  </td>
                  <td className="right">
                    <Button size="sm" onClick={() => setPaying(supplier)}>
                      {t.inventory.pay}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
      <Dialog
        open={paying !== null}
        title={`${t.inventory.pay}: ${paying?.name ?? ''}`}
        onClose={() => setPaying(null)}
      >
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!paying || !amount) return;
            void act(() =>
              post(`/suppliers/${paying.id}/payments`, { amount }),
            ).then(() => {
              setPaying(null);
              setAmount(null);
            });
          }}
        >
          <MoneyField
            label={`${t.payment.amount} (${t.menu.sum})`}
            value={amount}
            onChange={setAmount}
            required
          />
          <Button type="submit" variant="primary">
            {t.common.save}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

function MovementsTab() {
  const movements = useQuery({
    queryKey: ['inventory', 'movements'],
    queryFn: () =>
      api<{
        movements: {
          id: string;
          type: string;
          stockItem: string;
          unitLabel: string;
          quantity: string;
          balanceAfter: string;
          reason: string | null;
          createdAt: string;
        }[];
      }>('/inventory/movements?limit=200').then((data) => data.movements),
  });
  if (movements.isPending) return <LoadingState />;
  if (movements.error) return <ErrorState error={movements.error} />;
  if (movements.data.length === 0) return <EmptyState />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t.orders.time}</th>
            <th>{t.inventory.item}</th>
            <th>{t.orders.type}</th>
            <th className="right">{t.pos.quantity}</th>
            <th className="right">{t.inventory.balanceAfter}</th>
            <th>{t.inventory.reason}</th>
          </tr>
        </thead>
        <tbody>
          {movements.data.map((row) => (
            <tr key={row.id}>
              <td className="nowrap">{formatDateTime(row.createdAt)}</td>
              <td>{row.stockItem}</td>
              <td>{t.inventory.movementTypes[row.type] ?? row.type}</td>
              <td
                className={`right nowrap ${Number(row.quantity) < 0 ? 'danger-text' : ''}`}
              >
                {Number(row.quantity) > 0 ? '+' : ''}
                {qty(row.quantity)} {row.unitLabel}
              </td>
              <td className="right nowrap">
                {qty(row.balanceAfter)} {row.unitLabel}
              </td>
              <td>{row.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tab = 'stock' | 'purchases' | 'suppliers' | 'movements';

export function InventoryPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>('stock');
  const tabs: Tab[] = can(me, 'purchasing.manage')
    ? ['stock', 'purchases', 'suppliers', 'movements']
    : ['stock', 'movements'];
  return (
    <>
      <PageHeader title={t.inventory.title} subtitle={t.inventory.subtitle} />
      <div className="tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.inventory.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'stock' && <StockTab />}
      {tab === 'purchases' && <PurchasesTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'movements' && <MovementsTab />}
    </>
  );
}
