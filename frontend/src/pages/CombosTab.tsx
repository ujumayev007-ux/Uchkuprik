import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Button,
  Dialog,
  EmptyState,
  FormError,
  MoneyField,
  SelectField,
  TextField,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import type { Category, Product } from './MenuPage';

const c = t.combos;
type Part = { variantId: string; quantity: number };
type ComboVariant = Product['variants'][number] & { components?: Part[] };

const isCombo = (product: Product) =>
  ((product.variants[0] as ComboVariant | undefined)?.components ?? []).length >
  0;

function ComboForm({
  combo,
  products,
  categories,
  onDone,
}: {
  combo: Product | null;
  products: Product[];
  categories: Category[];
  onDone: () => void;
}) {
  const first = combo?.variants[0] as ComboVariant | undefined;
  const [name, setName] = useState(combo?.name ?? '');
  const [categoryId, setCategoryId] = useState(
    combo?.categoryId ?? categories[0]?.id ?? '',
  );
  const [price, setPrice] = useState<number | null>(first?.basePrice ?? null);
  const [parts, setParts] = useState<Part[]>(first?.components ?? []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Any active non-set item can be part of a set.
  const choices = products
    .filter(
      (product) =>
        product.isActive && !isCombo(product) && product.id !== combo?.id,
    )
    .flatMap((product) =>
      product.variants
        .filter((variant) => variant.isActive)
        .map((variant) => ({
          id: variant.id,
          label:
            variant.name === 'Standart' || product.variants.length === 1
              ? product.name
              : `${product.name} (${variant.name})`,
          price: variant.basePrice,
        })),
    );
  const quantityOf = (variantId: string) =>
    parts.find((part) => part.variantId === variantId)?.quantity ?? 0;
  const setQuantity = (variantId: string, quantity: number) =>
    setParts(
      quantity <= 0
        ? parts.filter((part) => part.variantId !== variantId)
        : parts.some((part) => part.variantId === variantId)
          ? parts.map((part) =>
              part.variantId === variantId ? { ...part, quantity } : part,
            )
          : [...parts, { variantId, quantity }],
    );
  const separate = parts.reduce(
    (sum, part) =>
      sum +
      (choices.find((choice) => choice.id === part.variantId)?.price ?? 0) *
        part.quantity,
    0,
  );
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        if (parts.length === 0) {
          setError(new Error(c.needItems));
          return;
        }
        setBusy(true);
        try {
          const body = {
            categoryId,
            name,
            variants: [
              {
                ...(first ? { id: first.id } : {}),
                name: 'Standart',
                price: price ?? 0,
              },
            ],
          };
          let variantId = first?.id;
          if (combo) await patch(`/menu/products/${combo.id}`, body);
          else {
            const created = await post<{ id: string }>('/menu/products', body);
            const menu = await api<{ products: Product[] }>('/menu?all=true');
            variantId = menu.products.find(
              (product) => product.id === created.id,
            )?.variants[0]?.id;
          }
          if (variantId)
            await api(`/menu/variants/${variantId}/components`, {
              method: 'PUT',
              body: { components: parts },
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
        <TextField
          label={c.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <SelectField
          label={c.category}
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>
        <MoneyField
          label={c.price}
          value={price}
          onChange={setPrice}
          required
        />
      </div>
      <fieldset>
        <legend>{c.contents}</legend>
        <p className="muted small">{c.contentsHint}</p>
        <ul className="ops-list">
          {choices.map((choice) => (
            <li key={choice.id} className="ops-item">
              <div className="grow">
                {choice.label}{' '}
                <span className="muted small">{formatMoney(choice.price)}</span>
              </div>
              <div className="qty-stepper">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="−"
                  onClick={() =>
                    setQuantity(choice.id, quantityOf(choice.id) - 1)
                  }
                >
                  −
                </button>
                <strong>{quantityOf(choice.id)}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="+"
                  onClick={() =>
                    setQuantity(choice.id, quantityOf(choice.id) + 1)
                  }
                >
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>
        {separate > 0 && (
          <p className="muted small">Alohida narxi: {formatMoney(separate)}</p>
        )}
      </fieldset>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

export function CombosTab({
  products,
  categories,
}: {
  products: Product[];
  categories: Category[];
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const combos = products.filter(isCombo);
  const nameOf = (variantId: string) => {
    for (const product of products)
      for (const variant of product.variants)
        if (variant.id === variantId) return product.name;
    return '—';
  };
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {c.add}
        </Button>
      </div>
      {combos.length === 0 ? (
        <EmptyState title={c.empty} />
      ) : (
        <ul className="ops-list">
          {combos.map((combo) => {
            const variant = combo.variants[0] as ComboVariant;
            return (
              <li key={combo.id} className="ops-item">
                <div className="grow">
                  <strong>{combo.name}</strong>
                  <div className="muted small">
                    {(variant.components ?? [])
                      .map(
                        (part) => `${part.quantity}× ${nameOf(part.variantId)}`,
                      )
                      .join(', ')}
                  </div>
                </div>
                <strong>{formatMoney(variant.basePrice)}</strong>
                <Button size="sm" onClick={() => setEditing(combo)}>
                  {t.common.edit}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? c.add : c.edit}
        onClose={() => setEditing(null)}
        wide
      >
        {editing !== null && (
          <ComboForm
            combo={editing === 'new' ? null : editing}
            products={products}
            categories={categories}
            onDone={() => {
              setEditing(null);
              void client.invalidateQueries({ queryKey: ['menu'] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
