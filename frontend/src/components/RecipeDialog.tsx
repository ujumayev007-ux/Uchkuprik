import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useStockItems } from '../pages/InventoryPage';
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

/** Edits the ingredients consumed per sold unit of each product variant. */
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
  const [lines, setLines] = useState<
    { stockItemId: string; quantity: string }[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (recipe.data)
      setLines(
        recipe.data.lines.map(({ stockItemId, quantity }) => ({
          stockItemId,
          quantity,
        })),
      );
  }, [recipe.data]);
  const items = (stock.data ?? []).filter((item) => item.isActive);

  return (
    <Dialog
      open
      title={`${t.inventory.recipe}: ${product.name}`}
      description={t.inventory.recipeHint}
      onClose={onClose}
      wide
    >
      <div className="stack">
        {variants.length > 1 && (
          <div className="segmented">
            {variants.map((variant) => (
              <button
                key={variant.id}
                className={variantId === variant.id ? 'active' : ''}
                aria-pressed={variantId === variant.id}
                onClick={() => setVariantId(variant.id)}
              >
                {variant.name}
              </button>
            ))}
          </div>
        )}
        <div className="variant-list">
          {lines.map((line, index) => {
            const item = items.find(
              (candidate) => candidate.id === line.stockItemId,
            );
            return (
              <div key={index} className="variant-row">
                <SelectField
                  label={t.inventory.ingredient}
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
                      {candidate.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  label={`${t.pos.quantity} (${item?.unitLabel ?? ''})`}
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
            setLines([...lines, { stockItemId: items[0]!.id, quantity: '' }])
          }
        >
          + {t.inventory.addIngredient}
        </Button>
        {recipe.data?.recipeCost !== undefined && (
          <p className="muted">
            {t.inventory.recipeCost}:{' '}
            <strong>{formatMoney(recipe.data.recipeCost)}</strong>
          </p>
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
                  body: { lines: lines.filter((line) => line.quantity) },
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
