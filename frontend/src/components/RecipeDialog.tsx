import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useStockItems, type StockItem } from '../pages/InventoryPage';
import type { Product } from '../pages/MenuPage';
import {
  Button,
  Dialog,
  FormError,
  SelectField,
  TextField,
  useToast,
} from './ui';

type Recipe = {
  lines: { stockItemId: string; quantity: string }[];
  recipeCost?: number;
};

type Line = { stockItemId: string; quantity: string; unitName: string };

const r = t.recipe;

/** Factor of a unit name to the item's base unit (g, ml or dona). */
const factorOf = (item: StockItem | undefined, unitName: string) =>
  !item || unitName === item.unitLabel
    ? 1
    : Number(item.units.find((unit) => unit.name === unitName)?.factor ?? 1);

const fmt = (value: number) =>
  value
    .toLocaleString('uz-UZ', { maximumFractionDigits: 3 })
    .replace(/,/g, ' ');

/**
 * Ingredients of one sold unit of each product variant (e.g. a hot dog: 1 dona sausage,
 * 1 dona bun, 20 g sauce). Completed orders deduct them from stock automatically.
 */
export function RecipeDialog({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  const variants = product.variants.filter((variant) => variant.isActive);
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  const stock = useStockItems();
  const client = useQueryClient();
  const toast = useToast();
  const recipe = useQuery({
    queryKey: ['recipe', variantId],
    queryFn: () => api<Recipe>(`/recipes/${variantId}`),
    enabled: !!variantId,
  });
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const all = stock.data ?? [];
  const items = all.filter((item) => item.isActive);
  const byId = new Map(all.map((item) => [item.id, item]));
  useEffect(() => {
    if (recipe.data)
      setLines(
        recipe.data.lines.map(({ stockItemId, quantity }) => ({
          stockItemId,
          quantity: String(Number(quantity)),
          unitName: byId.get(stockItemId)?.unitLabel ?? '',
        })),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe.data, stock.data]);

  const baseQty = (line: Line) =>
    Number(line.quantity || 0) *
    factorOf(byId.get(line.stockItemId), line.unitName);
  const update = (index: number, change: Partial<Line>) =>
    setLines(
      lines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    );

  const valid = lines.filter((line) => line.stockItemId && baseQty(line) > 0);
  const showCost = valid.some(
    (line) => byId.get(line.stockItemId)?.avgCost !== undefined,
  );
  const cost = valid.reduce(
    (sum, line) =>
      sum + baseQty(line) * Number(byId.get(line.stockItemId)?.avgCost ?? 0),
    0,
  );
  const portions = valid.length
    ? Math.min(
        ...valid.map((line) =>
          Math.floor(
            Math.max(0, Number(byId.get(line.stockItemId)?.quantity ?? 0)) /
              baseQty(line),
          ),
        ),
      )
    : null;
  const variant = variants.find((candidate) => candidate.id === variantId);

  return (
    <Dialog
      open
      title={`${r.title}: ${product.name}`}
      description={r.hint}
      onClose={onClose}
      wide
    >
      <div className="stack">
        {variants.length > 1 && (
          <div className="segmented">
            {variants.map((candidate) => (
              <button
                key={candidate.id}
                className={variantId === candidate.id ? 'active' : ''}
                aria-pressed={variantId === candidate.id}
                onClick={() => setVariantId(candidate.id)}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        )}
        {lines.length === 0 && <p className="muted">{r.empty}</p>}
        <div className="variant-list">
          {lines.map((line, index) => {
            const item = byId.get(line.stockItemId);
            const base = baseQty(line);
            return (
              <div key={index} className="purchase-row">
                <SelectField
                  label={r.ingredient}
                  value={line.stockItemId}
                  onChange={(e) => {
                    const next = byId.get(e.target.value);
                    update(index, {
                      stockItemId: e.target.value,
                      unitName: next?.unitLabel ?? '',
                    });
                  }}
                >
                  {items.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={r.amount}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) =>
                    update(index, {
                      quantity: e.target.value.replace(',', '.'),
                    })
                  }
                  required
                />
                <SelectField
                  label={r.unit}
                  value={line.unitName}
                  onChange={(e) => update(index, { unitName: e.target.value })}
                >
                  {item &&
                    [
                      item.unitLabel,
                      ...item.units.map((unit) => unit.name),
                    ].map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                </SelectField>
                <div className="small muted">
                  {item && (
                    <>
                      {r.inStock}: {fmt(Number(item.quantity))} {item.unitLabel}
                      {item.avgCost !== undefined && base > 0 && (
                        <>
                          <br />
                          {r.lineCost}:{' '}
                          {formatMoney(Math.round(base * Number(item.avgCost)))}
                        </>
                      )}
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setLines(lines.filter((_, i) => i !== index))}
                >
                  {t.menu.removeVariant}
                </button>
              </div>
            );
          })}
        </div>
        <Button
          size="sm"
          disabled={items.length === 0}
          onClick={() =>
            setLines([
              ...lines,
              {
                stockItemId: items[0]!.id,
                quantity: '',
                unitName: items[0]!.unitLabel,
              },
            ])
          }
        >
          + {r.add}
        </Button>
        {items.length === 0 && <p className="muted small">{r.noStock}</p>}
        {valid.length > 0 && (
          <div className="card stack">
            {showCost && (
              <p>
                {r.cost}: <strong>{formatMoney(Math.round(cost))}</strong>
                {variant && variant.price > 0 && (
                  <>
                    {' '}
                    · {r.margin}:{' '}
                    <strong>
                      {formatMoney(variant.price - Math.round(cost))}
                    </strong>
                  </>
                )}
              </p>
            )}
            {portions !== null && (
              <p>
                {r.portions}: <strong>{fmt(portions)}</strong>
              </p>
            )}
          </div>
        )}
        <FormError error={error} />
        <div className="form-actions">
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/recipes/${variantId}`, {
                  method: 'PUT',
                  body: {
                    lines: valid.map((line) => ({
                      stockItemId: line.stockItemId,
                      quantity: String(Math.round(baseQty(line) * 1000) / 1000),
                    })),
                  },
                });
                toast(t.common.saved);
                await client.invalidateQueries({
                  queryKey: ['recipe', variantId],
                });
              } catch (caught) {
                setError(caught);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.common.save}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
