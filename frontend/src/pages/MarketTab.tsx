import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
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
import { useStockItems } from './InventoryPage';

const m = t.market;
const NEW = '__new__';

type Line = {
  stockItemId: string;
  newName: string;
  newUnit: 'G' | 'ML' | 'PCS';
  quantity: string;
  unitName: string;
  lineTotal: number | null;
};

const empty = (): Line => ({
  stockItemId: '',
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
  createdAt: string;
  lines: {
    stockItemId: string;
    quantity: string;
    unitName: string;
    lineTotal: number;
  }[];
};

/** Market shopping: enter what was bought and how much was paid; stock goes up at once. */
export function MarketTab() {
  const items = useStockItems();
  const client = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>([empty()]);
  const [place, setPlace] = useState('Bozor');
  const [note, setNote] = useState('');
  const [paid, setPaid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
    return item ? [...item.units.map((unit) => unit.name), item.unitLabel] : [];
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
    setBusy(true);
    setError(null);
    try {
      await post('/purchases/market', {
        supplierName: place.trim() || 'Bozor',
        note: note.trim() || null,
        paid,
        lines: ready.map((line) => ({
          ...(line.stockItemId === NEW
            ? { newItem: { name: line.newName.trim(), baseUnit: line.newUnit } }
            : { stockItemId: line.stockItemId }),
          quantity: line.quantity,
          unitName: line.unitName,
          lineTotal: line.lineTotal,
        })),
      });
      toast(m.saved.replace('{sum}', formatMoney(total)));
      setLines([empty()]);
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
        <Checkbox label={m.paidCash} checked={paid} onChange={setPaid} />
        <p>
          {m.total}: <strong>{formatMoney(total)}</strong> ·{' '}
          {m.count.replace('{n}', String(ready.length))}
        </p>
        <FormError error={error} />
        <div className="form-actions">
          <Button
            variant="primary"
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
                  <th className="right">{m.total}</th>
                </tr>
              </thead>
              <tbody>
                {market.slice(0, 30).map((purchase) => (
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
                    <td className="right">
                      <Badge tone="success">
                        {formatMoney(purchase.total)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
