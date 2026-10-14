import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Button,
  Dialog,
  FormError,
  MoneyField,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useStockItems } from './InventoryPage';

const r = t.supplierReturn;
type Line = {
  stockItemId: string;
  quantity: string;
  unitName: string;
  amount: number | null;
};

/** Goods sent back to a supplier: stock goes down, the supplier debt too. */
export function SupplierReturnDialog({
  supplier,
  onClose,
}: {
  supplier: { id: string; name: string };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const items = useStockItems();
  const list = (items.data ?? []).filter((item) => item.isActive);
  const [lines, setLines] = useState<Line[]>([
    { stockItemId: '', quantity: '', unitName: '', amount: null },
  ]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const unitsFor = (id: string) => {
    const item = list.find((candidate) => candidate.id === id);
    return item ? [...item.units.map((unit) => unit.name), item.unitLabel] : [];
  };
  const set = (index: number, change: Partial<Line>) =>
    setLines(
      lines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    );
  const ready = lines.filter(
    (line) =>
      line.stockItemId && Number(line.quantity) > 0 && line.amount !== null,
  );
  const total = ready.reduce((sum, line) => sum + (line.amount ?? 0), 0);

  return (
    <Dialog open wide title={`${r.title}: ${supplier.name}`} onClose={onClose}>
      <div className="stack">
        {lines.map((line, index) => (
          <div key={index} className="purchase-row">
            <SelectField
              label={t.market.product}
              value={line.stockItemId}
              onChange={(e) =>
                set(index, {
                  stockItemId: e.target.value,
                  unitName: unitsFor(e.target.value)[0] ?? '',
                })
              }
            >
              <option value="">—</option>
              {list.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t.market.quantity}
              inputMode="decimal"
              value={line.quantity}
              onChange={(e) =>
                set(index, { quantity: e.target.value.replace(',', '.') })
              }
            />
            <SelectField
              label={t.market.unit}
              value={line.unitName}
              onChange={(e) => set(index, { unitName: e.target.value })}
            >
              {unitsFor(line.stockItemId).map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </SelectField>
            <MoneyField
              label={r.amount}
              value={line.amount}
              onChange={(amount) => set(index, { amount })}
            />
          </div>
        ))}
        <div className="toolbar">
          <Button
            size="sm"
            onClick={() =>
              setLines([
                ...lines,
                { stockItemId: '', quantity: '', unitName: '', amount: null },
              ])
            }
          >
            + {t.market.addLine}
          </Button>
        </div>
        <TextField
          label={r.reason}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={3}
          required
        />
        <p>
          {r.total}: <strong>{formatMoney(total)}</strong>
        </p>
        <FormError error={error} />
        <div className="form-actions">
          <Button
            variant="primary"
            disabled={ready.length === 0 || reason.trim().length < 3}
            onClick={async () => {
              setError(null);
              try {
                await post(`/suppliers/${supplier.id}/returns`, {
                  reason,
                  lines: ready.map((line) => ({
                    ...line,
                    amount: line.amount ?? 0,
                  })),
                });
                toast(r.done);
                await client.invalidateQueries({ queryKey: ['inventory'] });
                onClose();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            {r.save}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
