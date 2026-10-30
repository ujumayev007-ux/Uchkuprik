import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { can, useMe } from '../auth/session';
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
import { StationTemplateDialog } from './StationTemplateDialog';
import { CombosTab } from './CombosTab';
import { BrandSelect } from '../lib/brands';
import { api, del, patch, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { RecipeDialog } from '../components/RecipeDialog';
import { ProductImageField } from '../components/ProductImageField';
import { MenuImportDialog } from './MenuImportDialog';
import { useStations, type Station } from './KitchenPage';

export type Variant = {
  id: string;
  name: string;
  basePrice: number;
  branchPrice: number | null;
  price: number;
  available: boolean;
  isActive: boolean;
  cost?: number | null;
};
export type Product = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  allergens: string[];
  prepTimeMinutes: number | null;
  isActive: boolean;
  sortOrder: number;
  version: number;
  modifierGroupIds: string[];
  variants: Variant[];
};
export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  stationId: string | null;
  brandId: string | null;
  sortOrder: number;
  isActive: boolean;
};
export type ModifierOption = {
  id: string;
  name: string;
  price: number;
  isActive: boolean;
  cost?: number | null;
};
export type ModifierGroup = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive: boolean;
  options: ModifierOption[];
};
export type Menu = {
  branchId: string;
  categories: Category[];
  products: Product[];
  modifierGroups: ModifierGroup[];
};

export function useMenu(branchId: string | null | undefined, all = false) {
  return useQuery({
    queryKey: ['menu', branchId, all],
    queryFn: () => api<Menu>(`/menu?branchId=${branchId}&all=${all}`),
    enabled: !!branchId,
  });
}

/** Categories in tree order with depth, for indented lists and selects. */
export function categoryTree(categories: Category[]) {
  const result: (Category & { depth: number })[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const category of categories.filter(
      (item) => item.parentId === parentId,
    )) {
      result.push({ ...category, depth });
      visit(category.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

function CategoryForm({
  category,
  categories,
  onDone,
}: {
  category: Category | null;
  categories: Category[];
  onDone: () => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [parentId, setParentId] = useState(category?.parentId ?? '');
  const [stationId, setStationId] = useState(category?.stationId ?? '');
  const [brandId, setBrandId] = useState(category?.brandId ?? '');
  const stations = useStations();
  const [sortOrder, setSortOrder] = useState(category?.sortOrder ?? 0);
  const [isActive, setActive] = useState(category?.isActive ?? true);
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
          name,
          parentId: parentId || null,
          stationId: stationId || null,
          brandId: brandId || null,
          sortOrder,
          isActive,
        };
        try {
          if (category) await patch(`/menu/categories/${category.id}`, body);
          else await post('/menu/categories', body);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={t.common.name}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoFocus
      />
      <SelectField
        label={t.menu.parentCategory}
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
      >
        <option value="">{t.menu.noParent}</option>
        {categoryTree(categories)
          .filter((item) => item.id !== category?.id)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {'— '.repeat(item.depth)}
              {item.name}
            </option>
          ))}
      </SelectField>
      <SelectField
        label={t.kitchen.station}
        value={stationId}
        onChange={(e) => setStationId(e.target.value)}
      >
        <option value="">{t.kitchen.noStation}</option>
        {(stations.data ?? []).map((station) => (
          <option key={station.id} value={station.id}>
            {station.name}
          </option>
        ))}
      </SelectField>
      <BrandSelect
        value={brandId}
        emptyLabel={t.brands.shared}
        onChange={setBrandId}
      />
      <TextField
        label={t.floor.sortOrder}
        type="number"
        min={0}
        value={sortOrder}
        onChange={(e) => setSortOrder(Number(e.target.value))}
      />
      <Checkbox
        label={t.common.active}
        checked={isActive}
        onChange={setActive}
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

type VariantDraft = {
  id?: string;
  name: string;
  price: number | null;
  cost: number | null;
  isActive: boolean;
};

function ProductForm({
  product,
  menu,
  defaultCategoryId,
  showCost,
  onDone,
}: {
  product: Product | null;
  menu: Menu;
  defaultCategoryId: string;
  showCost: boolean;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    categoryId: product?.categoryId ?? defaultCategoryId,
    name: product?.name ?? '',
    description: product?.description ?? '',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    imageUrl: product?.imageUrl ?? '',
    allergens: product?.allergens.join(', ') ?? '',
    prepTimeMinutes: product?.prepTimeMinutes?.toString() ?? '',
    isActive: product?.isActive ?? true,
    sortOrder: product?.sortOrder ?? 0,
    modifierGroupIds: product?.modifierGroupIds ?? [],
  });
  const [variants, setVariants] = useState<VariantDraft[]>(
    product?.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      price: variant.basePrice,
      cost: variant.cost ?? null,
      isActive: variant.isActive,
    })) ?? [{ name: 'Standart', price: null, cost: null, isActive: true }],
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const updateVariant = (index: number, change: Partial<VariantDraft>) =>
    setVariants((list) =>
      list.map((item, i) => (i === index ? { ...item, ...change } : item)),
    );
  const blank = (value: string) => (value.trim() ? value.trim() : null);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          categoryId: form.categoryId,
          name: form.name,
          description: blank(form.description),
          sku: blank(form.sku),
          barcode: blank(form.barcode),
          imageUrl: blank(form.imageUrl),
          allergens: form.allergens
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          prepTimeMinutes: form.prepTimeMinutes
            ? Number(form.prepTimeMinutes)
            : null,
          isActive: form.isActive,
          sortOrder: form.sortOrder,
          modifierGroupIds: form.modifierGroupIds,
          variants: variants.map((variant) => ({
            ...(variant.id ? { id: variant.id } : {}),
            name: variant.name,
            price: variant.price ?? 0,
            ...(showCost ? { cost: variant.cost } : {}),
            isActive: variant.isActive,
          })),
        };
        try {
          if (product) await patch(`/menu/products/${product.id}`, body);
          else await post('/menu/products', body);
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
          label={t.menu.productName}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          autoFocus
        />
        <SelectField
          label={t.menu.category}
          value={form.categoryId}
          onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
          required
        >
          {categoryTree(menu.categories).map((item) => (
            <option key={item.id} value={item.id}>
              {'— '.repeat(item.depth)}
              {item.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={`${t.common.description} (${t.common.optional})`}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <TextField
          label={`${t.menu.sku} (${t.common.optional})`}
          value={form.sku}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
        />
        <TextField
          label={`${t.menu.barcode} (${t.common.optional})`}
          value={form.barcode}
          onChange={(e) => setForm({ ...form, barcode: e.target.value })}
        />
        <TextField
          label={`${t.menu.prepTime} (${t.common.optional})`}
          type="number"
          min={0}
          max={600}
          value={form.prepTimeMinutes}
          onChange={(e) =>
            setForm({ ...form, prepTimeMinutes: e.target.value })
          }
        />
        <TextField
          label={`${t.menu.allergens} (${t.common.optional})`}
          hint={t.menu.allergensHint}
          value={form.allergens}
          onChange={(e) => setForm({ ...form, allergens: e.target.value })}
        />
      </div>
      <ProductImageField
        value={form.imageUrl}
        onChange={(imageUrl) => setForm({ ...form, imageUrl })}
      />
      <fieldset>
        <legend>{t.menu.variants}</legend>
        <div className="variant-list">
          {variants.map((variant, index) => (
            <div
              key={variant.id ?? `new-${index}`}
              className={`variant-row ${showCost ? 'with-cost' : ''}`}
            >
              <TextField
                label={t.menu.variantName}
                value={variant.name}
                onChange={(e) => updateVariant(index, { name: e.target.value })}
                required
              />
              <MoneyField
                label={`${t.menu.price} (${t.menu.sum})`}
                value={variant.price}
                onChange={(price) => updateVariant(index, { price })}
                required
              />
              {showCost && (
                <MoneyField
                  label={`${t.menu.cost} (${t.menu.sum})`}
                  value={variant.cost}
                  onChange={(cost) => updateVariant(index, { cost })}
                />
              )}
              <div className="variant-actions">
                <Checkbox
                  label={t.menu.available}
                  checked={variant.isActive}
                  onChange={(isActive) => updateVariant(index, { isActive })}
                />
                {variants.length > 1 && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      setVariants((list) => list.filter((_, i) => i !== index))
                    }
                  >
                    {t.menu.removeVariant}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          onClick={() =>
            setVariants((list) => [
              ...list,
              { name: '', price: null, cost: null, isActive: true },
            ])
          }
        >
          + {t.menu.addVariant}
        </Button>
      </fieldset>
      {menu.modifierGroups.length > 0 && (
        <fieldset>
          <legend>{t.menu.modifierGroups}</legend>
          <div className="check-grid">
            {menu.modifierGroups.map((group) => (
              <Checkbox
                key={group.id}
                label={group.name}
                checked={form.modifierGroupIds.includes(group.id)}
                onChange={(on) =>
                  setForm({
                    ...form,
                    modifierGroupIds: on
                      ? [...form.modifierGroupIds, group.id]
                      : form.modifierGroupIds.filter((id) => id !== group.id),
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      )}
      <Checkbox
        label={t.menu.visibleField}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <p className="muted small" style={{ margin: 0 }}>
        {t.menu.visibleHint}
      </p>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

type OptionDraft = {
  id?: string;
  name: string;
  price: number | null;
  cost: number | null;
  isActive: boolean;
};

function GroupForm({
  group,
  showCost,
  onDone,
}: {
  group: ModifierGroup | null;
  showCost: boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [minSelect, setMin] = useState(group?.minSelect ?? 0);
  const [maxSelect, setMax] = useState(group?.maxSelect ?? 1);
  const [isActive, setActive] = useState(group?.isActive ?? true);
  const [options, setOptions] = useState<OptionDraft[]>(
    group?.options.map((option) => ({
      id: option.id,
      name: option.name,
      price: option.price,
      cost: option.cost ?? null,
      isActive: option.isActive,
    })) ?? [{ name: '', price: 0, cost: null, isActive: true }],
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const update = (index: number, change: Partial<OptionDraft>) =>
    setOptions((list) =>
      list.map((item, i) => (i === index ? { ...item, ...change } : item)),
    );
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const body = {
          name,
          minSelect,
          maxSelect,
          isActive,
          options: options.map((option) => ({
            ...(option.id ? { id: option.id } : {}),
            name: option.name,
            price: option.price ?? 0,
            ...(showCost ? { cost: option.cost } : {}),
            isActive: option.isActive,
          })),
        };
        try {
          if (group) await patch(`/menu/modifier-groups/${group.id}`, body);
          else await post('/menu/modifier-groups', body);
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
          label={t.menu.groupName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <TextField
          label={t.menu.minSelect}
          type="number"
          min={0}
          max={20}
          value={minSelect}
          onChange={(e) => setMin(Number(e.target.value))}
        />
        <TextField
          label={t.menu.maxSelect}
          type="number"
          min={1}
          max={20}
          value={maxSelect}
          onChange={(e) => setMax(Number(e.target.value))}
        />
      </div>
      <fieldset>
        <legend>{t.menu.options}</legend>
        <div className="variant-list">
          {options.map((option, index) => (
            <div
              key={option.id ?? `new-${index}`}
              className={`variant-row ${showCost ? 'with-cost' : ''}`}
            >
              <TextField
                label={t.common.name}
                value={option.name}
                onChange={(e) => update(index, { name: e.target.value })}
                required
              />
              <MoneyField
                label={`${t.menu.price} (${t.menu.sum})`}
                value={option.price}
                onChange={(price) => update(index, { price })}
                required
              />
              {showCost && (
                <MoneyField
                  label={`${t.menu.cost} (${t.menu.sum})`}
                  value={option.cost}
                  onChange={(cost) => update(index, { cost })}
                />
              )}
              <div className="variant-actions">
                <Checkbox
                  label={t.menu.available}
                  checked={option.isActive}
                  onChange={(on) => update(index, { isActive: on })}
                />
                {options.length > 1 && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      setOptions((list) => list.filter((_, i) => i !== index))
                    }
                  >
                    {t.menu.removeVariant}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          onClick={() =>
            setOptions((list) => [
              ...list,
              { name: '', price: 0, cost: null, isActive: true },
            ])
          }
        >
          + {t.menu.addOption}
        </Button>
      </fieldset>
      <Checkbox
        label={t.common.active}
        checked={isActive}
        onChange={setActive}
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

function BranchPrices({ menu, branchId }: { menu: Menu; branchId: string }) {
  const client = useQueryClient();
  const toast = useToast();
  const [changes, setChanges] = useState<
    Record<string, { price: number | null; isAvailable: boolean }>
  >({});
  const [busy, setBusy] = useState(false);
  const rows = menu.products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.isActive)
      .map((variant) => ({ product, variant })),
  );
  if (rows.length === 0) return <EmptyState />;
  const current = (variant: Variant) =>
    changes[variant.id] ?? {
      price: variant.branchPrice,
      isAvailable: variant.available,
    };
  return (
    <>
      <p className="muted">{t.menu.branchPricesHint}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t.menu.productName}</th>
              <th>{t.menu.basePrice}</th>
              <th>{t.menu.branchPrice}</th>
              <th>{t.menu.available}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ product, variant }) => {
              const value = current(variant);
              return (
                <tr key={variant.id}>
                  <td>
                    <strong>{product.name}</strong>
                    <small className="muted block">{variant.name}</small>
                  </td>
                  <td className="nowrap">{formatMoney(variant.basePrice)}</td>
                  <td>
                    <input
                      className="money-input compact"
                      inputMode="numeric"
                      aria-label={`${product.name} ${variant.name} ${t.menu.branchPrice}`}
                      placeholder={formatMoney(variant.basePrice)}
                      value={
                        value.price === null
                          ? ''
                          : value.price
                              .toString()
                              .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
                      }
                      onChange={(event) => {
                        const digits = event.target.value
                          .replace(/\D/g, '')
                          .slice(0, 10);
                        setChanges({
                          ...changes,
                          [variant.id]: {
                            ...value,
                            price: digits ? Number(digits) : null,
                          },
                        });
                      }}
                    />
                  </td>
                  <td>
                    <Checkbox
                      label={
                        value.isAvailable
                          ? t.menu.available
                          : t.menu.unavailable
                      }
                      checked={value.isAvailable}
                      onChange={(isAvailable) =>
                        setChanges({
                          ...changes,
                          [variant.id]: { ...value, isAvailable },
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions sticky-actions">
        <Button
          variant="primary"
          busy={busy}
          disabled={Object.keys(changes).length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await api('/menu/branch-prices', {
                method: 'PUT',
                body: {
                  branchId,
                  items: Object.entries(changes).map(([variantId, value]) => ({
                    variantId,
                    ...value,
                  })),
                },
              });
              setChanges({});
              toast(t.common.saved);
              await client.invalidateQueries({ queryKey: ['menu'] });
            } catch (caught) {
              toast(
                caught instanceof Error ? caught.message : t.common.errorTitle,
                'error',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.common.save}
        </Button>
      </div>
    </>
  );
}

type Tab = 'products' | 'combos' | 'modifiers' | 'prices' | 'stations';

function StationsTab() {
  const [templateFor, setTemplateFor] = useState<Station | null>(null);
  const stations = useStations();
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const save = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['kitchen', 'stations'] });
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
          void save(() => post('/kitchen/stations', { name })).then(() =>
            setName(''),
          );
        }}
      >
        <TextField
          label={t.kitchen.stationName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Button type="submit" variant="primary">
          + {t.kitchen.addStation}
        </Button>
      </form>
      {(stations.data ?? []).length === 0 ? (
        <EmptyState />
      ) : (
        <div className="badges">
          {(stations.data ?? []).map((station) => (
            <span key={station.id} className="station-chip">
              {station.name}
              <button
                className="text-link"
                onClick={() =>
                  void save(() =>
                    patch(`/kitchen/stations/${station.id}`, {
                      name: station.name,
                      sortOrder: station.sortOrder,
                      isActive: !station.isActive,
                    }),
                  )
                }
              >
                {station.isActive ? t.common.active : t.common.inactive}
              </button>
              <button
                className="text-link"
                onClick={() => setTemplateFor(station)}
              >
                🧾 {t.ticketTemplate.button}
              </button>
              <select
                aria-label={t.kitchen.printType}
                value={station.printType ?? 'KITCHEN'}
                onChange={(event) =>
                  void save(() =>
                    patch(`/kitchen/stations/${station.id}`, {
                      name: station.name,
                      sortOrder: station.sortOrder,
                      isActive: station.isActive,
                      printType: event.target.value,
                    }),
                  )
                }
              >
                {(['KITCHEN', 'KEBAB', 'BAR'] as const).map((type) => (
                  <option key={type} value={type}>
                    {t.printRules.types[type]}
                  </option>
                ))}
              </select>
            </span>
          ))}
        </div>
      )}
      {templateFor && (
        <StationTemplateDialog
          station={templateFor}
          onClose={() => setTemplateFor(null)}
        />
      )}
    </div>
  );
}

export function MenuPage() {
  const { data: me } = useMe();
  const manage = can(me, 'menu.manage');
  const showCost = can(me, 'menu.cost.view');
  const menu = useMenu(me?.activeBranchId, manage);
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [tab, setTab] = useState<Tab>('products');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [visibility, setVisibility] = useState<'all' | 'visible' | 'hidden'>(
    'all',
  );
  const [dialog, setDialog] = useState<
    | { kind: 'category'; category: Category | null }
    | { kind: 'product'; product: Product | null }
    | { kind: 'group'; group: ModifierGroup | null }
    | null
  >(null);

  const [recipeFor, setRecipeFor] = useState<Product | null>(null);
  const [importing, setImporting] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ['menu'] });
  const tree = useMemo(
    () => categoryTree(menu.data?.categories ?? []),
    [menu.data],
  );
  const descendants = useMemo(() => {
    if (!categoryId || !menu.data) return null;
    const ids = new Set([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const category of menu.data.categories)
        if (
          category.parentId &&
          ids.has(category.parentId) &&
          !ids.has(category.id)
        ) {
          ids.add(category.id);
          grew = true;
        }
    }
    return ids;
  }, [categoryId, menu.data]);
  const products = (menu.data?.products ?? []).filter(
    (product) =>
      (!descendants || descendants.has(product.categoryId)) &&
      (visibility === 'all' ||
        product.isActive === (visibility === 'visible')) &&
      `${product.name} ${product.sku ?? ''} ${product.barcode ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const done = async () => {
    setDialog(null);
    toast(t.common.saved);
    await refresh();
  };
  // One tap: the product leaves (or comes back to) every selling menu.
  const setVisible = async (product: Product, isActive: boolean) => {
    try {
      await patch(`/menu/products/${product.id}/visibility`, { isActive });
      toast(
        (isActive ? t.menu.shownDone : t.menu.hiddenDone).replace(
          '{name}',
          product.name,
        ),
      );
      await refresh();
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };

  return (
    <>
      <PageHeader
        title={t.menu.title}
        subtitle={t.menu.subtitle}
        actions={
          manage && (
            <>
              <a
                className="btn btn-ghost btn-md"
                href="/api/menu/import/template"
                download
              >
                ⬇ {t.menu.excelTemplate}
              </a>
              <Button onClick={() => setImporting(true)}>
                ⬆ {t.menu.excelImport}
              </Button>
              <Button
                onClick={() => setDialog({ kind: 'category', category: null })}
              >
                + {t.menu.addCategory}
              </Button>
              {tab === 'modifiers' ? (
                <Button
                  variant="primary"
                  onClick={() => setDialog({ kind: 'group', group: null })}
                >
                  + {t.menu.addGroup}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={tree.length === 0}
                  onClick={() => setDialog({ kind: 'product', product: null })}
                >
                  + {t.menu.addProduct}
                </Button>
              )}
            </>
          )
        }
      />
      {manage && (
        <div className="tabs" role="tablist">
          {(
            [
              ['products', t.menu.products],
              ['combos', t.combos.tab],
              ['modifiers', t.menu.modifierGroups],
              ['prices', t.menu.branchPrices],
              ['stations', t.kitchen.stations],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`tab ${tab === key ? 'active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!me?.activeBranchId ? (
        <EmptyState title={t.nav.selectBranch} />
      ) : menu.isPending ? (
        <LoadingState />
      ) : menu.error ? (
        <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
      ) : tab === 'combos' ? (
        <CombosTab
          products={menu.data.products}
          categories={menu.data.categories}
        />
      ) : tab === 'stations' ? (
        <StationsTab />
      ) : tab === 'prices' ? (
        <BranchPrices menu={menu.data} branchId={me.activeBranchId} />
      ) : tab === 'modifiers' ? (
        menu.data.modifierGroups.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="card-list">
            {menu.data.modifierGroups.map((group) => (
              <article key={group.id} className="card role-card">
                <header>
                  <div>
                    <h2>{group.name}</h2>
                    <p className="muted">
                      {t.menu.minSelect}: {group.minSelect} · {t.menu.maxSelect}
                      : {group.maxSelect}
                      {group.minSelect > 0 && <> · {t.menu.required}</>}
                    </p>
                  </div>
                  {!group.isActive && <Badge>{t.common.inactive}</Badge>}
                </header>
                <div className="badges">
                  {group.options.map((option) => (
                    <Badge
                      key={option.id}
                      tone={option.isActive ? 'neutral' : 'warning'}
                    >
                      {option.name}{' '}
                      {option.price > 0 && `+${formatMoney(option.price)}`}
                    </Badge>
                  ))}
                </div>
                <div className="form-actions">
                  <Button
                    size="sm"
                    onClick={() => setDialog({ kind: 'group', group })}
                  >
                    {t.common.edit}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )
      ) : (
        <div className="menu-layout">
          <nav className="category-list" aria-label={t.menu.categories}>
            <button
              className={`category-item ${categoryId === null ? 'active' : ''}`}
              onClick={() => setCategoryId(null)}
            >
              {t.menu.allProducts}
            </button>
            {tree.map((category) => (
              <div
                key={category.id}
                className="category-row"
                style={{ paddingLeft: category.depth * 14 }}
              >
                <button
                  className={`category-item ${categoryId === category.id ? 'active' : ''} ${category.isActive ? '' : 'is-inactive'}`}
                  onClick={() => setCategoryId(category.id)}
                >
                  {category.name}
                </button>
                {manage && (
                  <button
                    className="icon-button small"
                    aria-label={`${t.menu.editCategory}: ${category.name}`}
                    onClick={() => setDialog({ kind: 'category', category })}
                  >
                    ✎
                  </button>
                )}
              </div>
            ))}
          </nav>
          <section>
            <div className="toolbar">
              <input
                type="search"
                className="search"
                placeholder={t.common.search}
                aria-label={t.common.search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {manage && (
                <div
                  className="segmented"
                  role="group"
                  aria-label={t.menu.visibleField}
                >
                  {(
                    [
                      ['all', t.menu.visibilityAll],
                      ['visible', t.menu.visible],
                      ['hidden', t.menu.hidden],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={visibility === key ? 'active' : ''}
                      aria-pressed={visibility === key}
                      onClick={() => setVisibility(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {products.length === 0 ? (
              <EmptyState title={t.menu.noProducts} />
            ) : (
              <div className="product-grid">
                {products.map((product) => (
                  <article
                    key={product.id}
                    className={`product-card ${product.isActive ? '' : 'is-inactive'}`}
                  >
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="product-placeholder" aria-hidden="true">
                        {product.name.slice(0, 1)}
                      </div>
                    )}
                    <div className="product-body">
                      <h3>{product.name}</h3>
                      {product.description && (
                        <p className="muted small">{product.description}</p>
                      )}
                      <ul className="variant-prices">
                        {product.variants.map((variant) => (
                          <li
                            key={variant.id}
                            className={variant.available ? '' : 'is-inactive'}
                          >
                            <span>{variant.name}</span>
                            <strong>{formatMoney(variant.price)}</strong>
                            {showCost && variant.cost != null && (
                              <small className="muted">
                                {t.menu.cost}: {formatMoney(variant.cost)}
                              </small>
                            )}
                          </li>
                        ))}
                      </ul>
                      {manage ? (
                        <Badge tone={product.isActive ? 'success' : 'warning'}>
                          {product.isActive ? t.menu.visible : t.menu.hidden}
                        </Badge>
                      ) : (
                        !product.isActive && <Badge>{t.common.inactive}</Badge>
                      )}
                      {manage && (
                        <div className="form-actions">
                          <Button
                            size="sm"
                            onClick={() =>
                              setDialog({ kind: 'product', product })
                            }
                          >
                            {t.common.edit}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => setRecipeFor(product)}
                          >
                            {t.inventory.recipe}
                          </Button>
                          <Button
                            size="sm"
                            variant={product.isActive ? 'ghost' : 'primary'}
                            onClick={() =>
                              void setVisible(product, !product.isActive)
                            }
                          >
                            {product.isActive
                              ? `🙈 ${t.menu.hide}`
                              : `👁 ${t.menu.show}`}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                              if (!(await confirm(t.menu.deleteConfirm)))
                                return;
                              try {
                                await del(`/menu/products/${product.id}`);
                                await refresh();
                              } catch (caught) {
                                toast(
                                  caught instanceof Error
                                    ? caught.message
                                    : t.common.errorTitle,
                                  'error',
                                );
                              }
                            }}
                          >
                            {t.common.delete}
                          </Button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      <Dialog
        open={dialog !== null}
        wide={dialog?.kind !== 'category'}
        title={
          dialog?.kind === 'category'
            ? dialog.category
              ? t.menu.editCategory
              : t.menu.addCategory
            : dialog?.kind === 'product'
              ? dialog.product
                ? t.menu.editProduct
                : t.menu.addProduct
              : dialog?.kind === 'group' && dialog.group
                ? t.menu.editGroup
                : t.menu.addGroup
        }
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === 'category' && menu.data && (
          <CategoryForm
            category={dialog.category}
            categories={menu.data.categories}
            onDone={done}
          />
        )}
        {dialog?.kind === 'product' && menu.data && (
          <ProductForm
            product={dialog.product}
            menu={menu.data}
            defaultCategoryId={categoryId ?? tree[0]?.id ?? ''}
            showCost={showCost}
            onDone={done}
          />
        )}
        {dialog?.kind === 'group' && (
          <GroupForm group={dialog.group} showCost={showCost} onDone={done} />
        )}
      </Dialog>
      {importing && (
        <MenuImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void refresh();
          }}
        />
      )}
      {recipeFor && (
        <RecipeDialog product={recipeFor} onClose={() => setRecipeFor(null)} />
      )}
      {confirmElement}
    </>
  );
}
