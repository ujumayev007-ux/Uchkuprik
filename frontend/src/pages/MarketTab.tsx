import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  FormError,
  MoneyField,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';
import { useStockItems, type StockItem } from './InventoryPage';
import { useStockRequests } from './StockRequestsTab';

const m = t.market;
const NEW = '__new__';

type Line = {
  stockItemId: string;
  // Where it was bought; empty = the place above.
  supplier: string;
  newName: string;
  newUnit: 'G' | 'ML' | 'PCS';
  quantity: string;
  unitName: string;
  lineTotal: number | null;
};

const empty = (): Line => ({
  stockItemId: '',
  supplier: '',
  newName: '',
  newUnit: 'G',
  quantity: '',
  unitName: '',
  lineTotal: null,
});

// Units a brand-new product can be bought in (base unit plus the usual big one).
const newUnits = { G: ['kg', 'g'], ML: ['l', 'ml'], PCS: ['dona'] } as const;

type Purchase = {
  id: string;
  supplier: string;
  status: string;
  total: number;
  note: string | null;
  paymentMethod?: 'CASH' | 'CARD' | 'DEBT';
  createdAt: string;
  lines: {
    stockItemId: string;
    quantity: string;
    unitName: string;
    lineTotal: number;
  }[];
};

/** Admin dialog to correct an already saved purchase with mandatory reason and audit trail. */
function CorrectionDialog({
  purchase,
  items,
  onClose,
  onSaved,
}: {
  purchase: Purchase;
  items: StockItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [supplierName, setSupplierName] = useState(purchase.supplier);
  const [note, setNote] = useState(purchase.note ?? '');
  const [lines, setLines] = useState<
    {
      stockItemId: string;
      quantity: string;
      unitName: string;
      lineTotal: number | null;
    }[]
  >(
    purchase.lines.map((l) => ({
      stockItemId: l.stockItemId,
      quantity: String(Number(l.quantity)),
      unitName: l.unitName,
      lineTotal: l.lineTotal,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ready = lines.filter(
    (l) => l.stockItemId && Number(l.quantity) > 0 && l.lineTotal !== null,
  );
  const total = ready.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0);

  const save = async () => {
    if (reason.trim().length < 3) {
      toast(m.correctionReasonPlaceholder, 'error');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/purchases/${purchase.id}/correct`, {
        reason: reason.trim(),
        supplierName: supplierName.trim() || undefined,
        note: note.trim() || null,
        lines: ready.map((l) => ({
          stockItemId: l.stockItemId,
          quantity: l.quantity,
          unitName: l.unitName,
          lineTotal: l.lineTotal,
        })),
      });
      toast(m.correctionSaved);
      onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open title={m.correctTitle} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">
          Xaridni tuzatish ombordagi qoldiqlarni qayta hisoblaydi va auditga
          to‘liq saqlanadi.
        </p>
        <div className="form-grid">
          <TextField
            label={m.place}
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            required
          />
          <TextField
            label={m.note}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="variant-list">
          {lines.map((line, idx) => {
            const item = items.find((i) => i.id === line.stockItemId);
            const units = item
              ? [
                  ...item.units.map((u) => u.name),
                  item.unitLabel,
                  ...(item.baseUnit === 'G'
                    ? ['kg']
                    : item.baseUnit === 'ML'
                      ? ['l']
                      : []),
                ]
              : [line.unitName];
            const uniqueUnits = [...new Set(units)];
            return (
              <div key={idx} className="purchase-row">
                <SelectField
                  label={m.product}
                  value={line.stockItemId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const nextItem = items.find((i) => i.id === nextId);
                    setLines(
                      lines.map((l, i) =>
                        i === idx
                          ? {
                              ...l,
                              stockItemId: nextId,
                              unitName:
                                nextItem?.units[0]?.name ??
                                nextItem?.unitLabel ??
                                l.unitName,
                            }
                          : l,
                      ),
                    );
                  }}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={m.quantity}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, i) =>
                        i === idx
                          ? { ...l, quantity: e.target.value.replace(',', '.') }
                          : l,
                      ),
                    )
                  }
                />
                <SelectField
                  label={m.unit}
                  value={line.unitName}
                  onChange={(e) =>
                    setLines(
                      lines.map((l, i) =>
                        i === idx ? { ...l, unitName: e.target.value } : l,
                      ),
                    )
                  }
                >
                  {uniqueUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </SelectField>
                <MoneyField
                  label={m.paidFor}
                  value={line.lineTotal}
                  onChange={(lineTotal) =>
                    setLines(
                      lines.map((l, i) => (i === idx ? { ...l, lineTotal } : l)),
                    )
                  }
                />
                <button
                  type="button"
                  className="text-link"
                  onClick={() =>
                    setLines(
                      lines.length > 1
                        ? lines.filter((_, i) => i !== idx)
                        : lines,
                    )
                  }
                >
                  {t.menu.removeVariant}
                </button>
              </div>
            );
          })}
        </div>
        <div className="toolbar">
          <Button
            size="sm"
            onClick={() =>
              setLines([
                ...lines,
                {
                  stockItemId: items[0]?.id ?? '',
                  quantity: '1',
                  unitName: items[0]?.unitLabel ?? 'dona',
                  lineTotal: 0,
                },
              ])
            }
          >
            + {m.addLine}
          </Button>
        </div>
        <TextField
          label={m.correctionReason}
          placeholder={m.correctionReasonPlaceholder}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
        <p>
          {m.total}: <strong>{formatMoney(total)}</strong> ·{' '}
          {m.count.replace('{n}', String(ready.length))}
        </p>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={ready.length === 0 || reason.trim().length < 3}
            onClick={save}
          >
            {m.saveCorrection}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Market shopping: enter what was bought and how much was paid; stock goes up at once. */
export function MarketTab({ isStandalonePage = false }: { isStandalonePage?: boolean }) {
  const me = useMe().data;
  const navigate = useNavigate();
  const items = useStockItems();
  const client = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>([empty()]);
  const approved = useStockRequests('APPROVED');
  const [requestIds, setRequestIds] = useState<string[]>([]);
  const [place, setPlace] = useState('Bozor');
  const [note, setNote] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD' | 'DEBT'>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [correcting, setCorrecting] = useState<Purchase | null>(null);

  const canAdmin = me ? can(me, 'purchasing.manage') : false;
  const list = (items.data ?? []).filter((item) => item.isActive);

  const history = useQuery({
    queryKey: ['inventory', 'purchases'],
    queryFn: () =>
      api<{ purchases: Purchase[] }>('/purchases').then(
        (data) => data.purchases,
      ),
  });
  const names = new Map((items.data ?? []).map((item) => [item.id, item]));

  const unitsFor = (line: Line): string[] => {
    if (line.stockItemId === NEW) return [...newUnits[line.newUnit]];
    const item = list.find((candidate) => candidate.id === line.stockItemId);
    if (!item) return [];
    const unitNames = [...item.units.map((unit) => unit.name), item.unitLabel];
    // kg / l are always available for gram / millilitre products.
    const standard =
      item.baseUnit === 'G' ? 'kg' : item.baseUnit === 'ML' ? 'l' : null;
    return standard && !unitNames.includes(standard)
      ? [standard, ...unitNames]
      : unitNames;
  };

  const set = (index: number, change: Partial<Line>) =>
    setLines(
      lines.map((line, i) => {
        if (i !== index) return line;
        const next = { ...line, ...change };
        if (!unitsFor(next).includes(next.unitName))
          next.unitName = unitsFor(next)[0] ?? '';
        return next;
      }),
    );

  const ready = lines.filter(
    (line) =>
      (line.stockItemId === NEW ? line.newName.trim() : line.stockItemId) &&
      Number(line.quantity) > 0 &&
      line.lineTotal !== null,
  );
  const total = ready.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);

  const save = async () => {
    if (ready.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      await post('/purchases/market', {
        supplierName: place.trim() || 'Bozor',
        note: note.trim() || null,
        paid: paymentMethod !== 'DEBT',
        paymentMethod,
        idempotencyKey,
        requestIds,
        lines: ready.map((line) => ({
          ...(line.stockItemId === NEW
            ? { newItem: { name: line.newName.trim(), baseUnit: line.newUnit } }
            : { stockItemId: line.stockItemId }),
          quantity: line.quantity,
          unitName: line.unitName,
          lineTotal: line.lineTotal,
          ...(line.supplier.trim()
            ? { supplierName: line.supplier.trim() }
            : {}),
        })),
      });
      toast(m.saved.replace('{sum}', formatMoney(total)));
      setLines([empty()]);
      setRequestIds([]);
      setNote('');
      await client.invalidateQueries({ queryKey: ['inventory'] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const market = (history.data ?? []).filter(
    (purchase) => purchase.status === 'RECEIVED',
  );

  return (
    <div className="stack">
      {isStandalonePage && (
        <div className="toolbar space-between">
          <Button variant="ghost" size="sm" onClick={() => navigate('/kassa')}>
            {m.backToPos}
          </Button>
          <h1>🛒 {m.title}</h1>
          <div />
        </div>
      )}

      {!canAdmin && (
        <div className="card" style={{ background: 'var(--color-bg-subtle, #f8f9fa)', borderLeft: '4px solid #0d6efd', padding: '12px 16px' }}>
          <p className="small" style={{ margin: 0 }}>
            ℹ️ {m.cashierNotice}
          </p>
        </div>
      )}

      <section className="card stack">
        <h2>🛒 {m.title}</h2>
        <p className="muted small">{m.hint}</p>

        <div className="form-grid">
          <TextField
            label={m.place}
            value={place}
            onChange={(event) => setPlace(event.target.value)}
          />
          <TextField
            label={m.note}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <div className="stack" style={{ marginTop: '4px', marginBottom: '8px' }}>
          <label className="field-label" style={{ fontWeight: 600 }}>
            {m.paymentMethod}
          </label>
          <div className="choice-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
            <button
              type="button"
              className={`choice ${paymentMethod === 'CASH' ? 'active' : ''}`}
              onClick={() => setPaymentMethod('CASH')}
            >
              {m.cash}
            </button>
            <button
              type="button"
              className={`choice ${paymentMethod === 'CARD' ? 'active' : ''}`}
              onClick={() => setPaymentMethod('CARD')}
            >
              {m.card}
            </button>
            <button
              type="button"
              className={`choice ${paymentMethod === 'DEBT' ? 'active' : ''}`}
              onClick={() => setPaymentMethod('DEBT')}
            >
              {m.debt}
            </button>
          </div>
          <span className="muted small">
            {paymentMethod === 'CASH' && 'Kassadagi smena naqd pulidan xarajat sifatida yoziladi.'}
            {paymentMethod === 'CARD' && 'Bank / karta orqali to‘landi. Kassa naqd puliga ta’sir qilmaydi.'}
            {paymentMethod === 'DEBT' && 'Ta’minotchi oldidagi qarz (nasiya) sifatida qayd etiladi. Kassa puli kamaymaydi.'}
          </span>
        </div>

        <div className="variant-list">
          {lines.map((line, index) => {
            const quantity = Number(line.quantity);
            const unitPrice =
              quantity > 0 && line.lineTotal !== null
                ? Math.round(line.lineTotal / quantity)
                : null;
            return (
              <div key={index} className="purchase-row">
                <SelectField
                  label={m.product}
                  value={line.stockItemId}
                  onChange={(event) =>
                    set(index, { stockItemId: event.target.value })
                  }
                >
                  <option value="">—</option>
                  {list.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                  <option value={NEW}>+ {m.newProduct}</option>
                </SelectField>
                {line.stockItemId === NEW && (
                  <>
                    <TextField
                      label={m.newName}
                      value={line.newName}
                      onChange={(event) =>
                        set(index, { newName: event.target.value })
                      }
                      required
                    />
                    <SelectField
                      label={m.measured}
                      value={line.newUnit}
                      onChange={(event) =>
                        set(index, {
                          newUnit: event.target.value as Line['newUnit'],
                        })
                      }
                    >
                      <option value="G">{m.byWeight}</option>
                      <option value="ML">{m.byVolume}</option>
                      <option value="PCS">{m.byPiece}</option>
                    </SelectField>
                  </>
                )}
                <TextField
                  label={m.quantity}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) =>
                    set(index, {
                      quantity: event.target.value.replace(',', '.'),
                    })
                  }
                />
                <SelectField
                  label={m.unit}
                  value={line.unitName}
                  onChange={(event) =>
                    set(index, { unitName: event.target.value })
                  }
                >
                  {unitsFor(line).map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={m.lineSupplier}
                  placeholder={place.trim() || 'Bozor'}
                  value={line.supplier}
                  onChange={(event) =>
                    set(index, { supplier: event.target.value })
                  }
                />
                <MoneyField
                  label={m.paidFor}
                  value={line.lineTotal}
                  onChange={(lineTotal) => set(index, { lineTotal })}
                  {...(unitPrice !== null
                    ? { hint: `${formatMoney(unitPrice)} / ${line.unitName}` }
                    : {})}
                />
                <button
                  type="button"
                  className="text-link"
                  onClick={() =>
                    setLines(
                      lines.length > 1
                        ? lines.filter((_, i) => i !== index)
                        : [empty()],
                    )
                  }
                >
                  {t.menu.removeVariant}
                </button>
              </div>
            );
          })}
        </div>
        <div className="toolbar">
          <Button size="sm" onClick={() => setLines([...lines, empty()])}>
            + {m.addLine}
          </Button>
        </div>

        {(approved.data ?? []).length > 0 && (
          <fieldset className="stack">
            <legend>{t.stockRequests.approvedList}</legend>
            {(approved.data ?? []).map((request) => (
              <Checkbox
                key={request.id}
                label={`${request.requestedBy ?? ''}: ${request.items
                  .map(
                    (item) =>
                      `${list.find((s) => s.id === item.stockItemId)?.name ?? '?'} ${Number(item.quantity)} ${item.unitName}`,
                  )
                  .join(', ')}`}
                checked={requestIds.includes(request.id)}
                onChange={(on) => {
                  setRequestIds(
                    on
                      ? [...requestIds, request.id]
                      : requestIds.filter((id) => id !== request.id),
                  );
                  if (on)
                    setLines([
                      ...lines.filter((line) => line.stockItemId),
                      ...request.items.map((item) => ({
                        ...empty(),
                        stockItemId: item.stockItemId,
                        quantity: String(Number(item.quantity)),
                        unitName: item.unitName,
                      })),
                    ]);
                }}
              />
            ))}
          </fieldset>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <p style={{ margin: 0, fontSize: '1.1rem' }}>
            {m.grandTotal}: <strong>{formatMoney(total)}</strong> ·{' '}
            {m.count.replace('{n}', String(ready.length))}
          </p>
          <span className="badge" style={{ padding: '6px 12px' }}>
            {paymentMethod === 'CASH' && m.cash}
            {paymentMethod === 'CARD' && m.card}
            {paymentMethod === 'DEBT' && m.debt}
          </span>
        </div>

        <FormError error={error} />
        <div className="form-actions">
          <Button
            variant="primary"
            size="lg"
            busy={busy}
            disabled={ready.length === 0}
            onClick={save}
          >
            {m.save}
          </Button>
        </div>
      </section>

      <section className="card stack">
        <h2>{m.history}</h2>
        {market.length === 0 ? (
          <EmptyState title={m.noHistory} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{m.date}</th>
                  <th>{m.place}</th>
                  <th>{m.products}</th>
                  <th>{m.method}</th>
                  <th className="right">{m.total}</th>
                  {canAdmin && <th className="right">{m.correct}</th>}
                </tr>
              </thead>
              <tbody>
                {market.slice(0, 30).map((purchase) => {
                  const method = purchase.paymentMethod ?? 'CASH';
                  return (
                    <tr key={purchase.id}>
                      <td>{formatDateTime(purchase.createdAt)}</td>
                      <td>
                        {purchase.supplier}
                        {purchase.note ? (
                          <div className="muted small">{purchase.note}</div>
                        ) : null}
                      </td>
                      <td className="small">
                        {purchase.lines
                          .map(
                            (line) =>
                              `${names.get(line.stockItemId)?.name ?? '?'} ${Number(line.quantity)} ${line.unitName}`,
                          )
                          .join(', ')}
                      </td>
                      <td>
                        <Badge
                          tone={
                            method === 'CASH'
                              ? 'success'
                              : method === 'CARD'
                                ? 'accent'
                                : 'warning'
                          }
                        >
                          {method === 'CASH'
                            ? 'Naqd'
                            : method === 'CARD'
                              ? 'Karta'
                              : 'Nasiya'}
                        </Badge>
                      </td>
                      <td className="right">
                        <strong>{formatMoney(purchase.total)}</strong>
                      </td>
                      {canAdmin && (
                        <td className="right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCorrecting(purchase)}
                            title={m.correct}
                          >
                            ✏️ {m.correct}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {correcting && (
        <CorrectionDialog
          purchase={correcting}
          items={list}
          onClose={() => setCorrecting(null)}
          onSaved={async () => {
            setCorrecting(null);
            await client.invalidateQueries({ queryKey: ['inventory'] });
          }}
        />
      )}
    </div>
  );
}
