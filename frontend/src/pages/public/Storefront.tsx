import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Dialog,
  FormError,
  TextField,
  useTheme,
} from '../../components/ui';
import { t } from '../../i18n';
import { post } from '../../lib/api';
import { formatMoney } from '../../lib/format';
import { newKey } from '../../lib/orders';

export type PublicMenu = {
  zones?: {
    id: string;
    name: string;
    fee: number;
    minOrder: number;
    etaMinutes: number | null;
  }[];
  categories: { id: string; name: string; parentId: string | null }[];
  products: {
    id: string;
    categoryId: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    allergens: string[];
    modifierGroupIds: string[];
    variants: { id: string; name: string; price: number }[];
  }[];
  modifierGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    options: { id: string; name: string; price: number }[];
  }[];
};
type Product = PublicMenu['products'][number];
type Line = {
  key: string;
  product: Product;
  variantId: string;
  options: { id: string; name: string; price: number }[];
  quantity: number;
};

const lineUnit = (line: Line) =>
  (line.product.variants.find((variant) => variant.id === line.variantId)
    ?.price ?? 0) + line.options.reduce((sum, option) => sum + option.price, 0);

function ProductDialog({
  product,
  menu,
  onAdd,
  onClose,
}: {
  product: Product;
  menu: PublicMenu;
  onAdd: (line: Line) => void;
  onClose: () => void;
}) {
  const [variantId, setVariantId] = useState(product.variants[0]!.id);
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const groups = product.modifierGroupIds
    .map((id) => menu.modifierGroups.find((group) => group.id === id))
    .filter((group) => !!group);
  const valid = groups.every((group) => {
    const count = group.options.filter((option) =>
      selected.includes(option.id),
    ).length;
    return count >= group.minSelect && count <= group.maxSelect;
  });
  const options = groups
    .flatMap((group) => group.options)
    .filter((option) => selected.includes(option.id));
  const unit =
    (product.variants.find((variant) => variant.id === variantId)?.price ?? 0) +
    options.reduce((sum, option) => sum + option.price, 0);
  return (
    <Dialog
      open
      title={product.name}
      description={product.description ?? undefined}
      onClose={onClose}
    >
      <div className="stack">
        {product.variants.length > 1 && (
          <div className="choice-grid">
            {product.variants.map((variant) => (
              <button
                key={variant.id}
                className={`choice ${variantId === variant.id ? 'active' : ''}`}
                aria-pressed={variantId === variant.id}
                onClick={() => setVariantId(variant.id)}
              >
                <span>{variant.name}</span>
                <strong>{formatMoney(variant.price)}</strong>
              </button>
            ))}
          </div>
        )}
        {groups.map((group) => (
          <fieldset key={group.id}>
            <legend>{group.name}</legend>
            <div className="choice-grid">
              {group.options.map((option) => {
                const on = selected.includes(option.id);
                return (
                  <button
                    key={option.id}
                    className={`choice ${on ? 'active' : ''}`}
                    aria-pressed={on}
                    onClick={() => {
                      const inGroup = group.options.filter((item) =>
                        selected.includes(item.id),
                      );
                      if (on)
                        setSelected(selected.filter((id) => id !== option.id));
                      else if (group.maxSelect === 1)
                        setSelected([
                          ...selected.filter(
                            (id) => !inGroup.some((item) => item.id === id),
                          ),
                          option.id,
                        ]);
                      else if (inGroup.length < group.maxSelect)
                        setSelected([...selected, option.id]);
                    }}
                  >
                    <span>{option.name}</span>
                    {option.price > 0 && (
                      <strong>+{formatMoney(option.price)}</strong>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <div className="qty-row">
          <span>{t.pos.quantity}</span>
          <div className="stepper">
            <button
              aria-label={t.pos.decrease}
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
            >
              −
            </button>
            <strong>{quantity}</strong>
            <button
              aria-label={t.pos.increase}
              onClick={() => setQuantity(Math.min(50, quantity + 1))}
            >
              +
            </button>
          </div>
        </div>
        <Button
          variant="primary"
          size="lg"
          disabled={!valid}
          onClick={() =>
            onAdd({ key: newKey(), product, variantId, options, quantity })
          }
        >
          {t.online.add} · {formatMoney(unit * quantity)}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Customer storefront used by both the website and table QR menus. The cart lives in
 * memory; prices shown are informational and the server recomputes everything.
 */
export function Storefront({
  title,
  subtitle,
  menu,
  source,
  header,
  needsContact,
  needsAddress,
  accent,
}: {
  title: string;
  subtitle?: string | undefined;
  menu: PublicMenu;
  source: Record<string, unknown>;
  header?: ReactNode;
  needsContact: boolean;
  needsAddress: boolean;
  // Brand colour; overrides the accent token for this storefront.
  accent?: string | null | undefined;
}) {
  const theme = useTheme();
  const navigate = useNavigate();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picking, setPicking] = useState<Product | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [checkout, setCheckout] = useState(false);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    address: '',
    note: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const products = useMemo(
    () =>
      menu.products.filter(
        (product) => !categoryId || product.categoryId === categoryId,
      ),
    [menu, categoryId],
  );
  const total = cart.reduce(
    (sum, line) => sum + lineUnit(line) * line.quantity,
    0,
  );
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);

  const add = (product: Product) => {
    if (product.variants.length === 1 && product.modifierGroupIds.length === 0)
      setCart((lines) => {
        const same = lines.find(
          (line) => line.product.id === product.id && line.options.length === 0,
        );
        if (same)
          return lines.map((line) =>
            line === same ? { ...line, quantity: line.quantity + 1 } : line,
          );
        return [
          ...lines,
          {
            key: newKey(),
            product,
            variantId: product.variants[0]!.id,
            options: [],
            quantity: 1,
          },
        ];
      });
    else setPicking(product);
  };

  return (
    <div
      className="store"
      style={
        accent ? ({ '--accent': accent } as React.CSSProperties) : undefined
      }
    >
      <header className="store-header">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          onClick={theme.toggle}
          aria-label={theme.dark ? t.nav.lightTheme : t.nav.darkTheme}
        >
          {theme.dark ? '☀' : '☾'}
        </button>
      </header>
      {header}
      <nav className="chip-row store-categories" aria-label={t.menu.categories}>
        <button
          className={`chip ${!categoryId ? 'active' : ''}`}
          onClick={() => setCategoryId(null)}
        >
          {t.common.all}
        </button>
        {menu.categories.map((category) => (
          <button
            key={category.id}
            className={`chip ${categoryId === category.id ? 'active' : ''}`}
            onClick={() => setCategoryId(category.id)}
          >
            {category.name}
          </button>
        ))}
      </nav>
      <main className="store-grid">
        {products.map((product) => (
          <button
            key={product.id}
            className="store-item"
            onClick={() => add(product)}
            aria-label={`${product.name} ${formatMoney(product.variants[0]!.price)}`}
          >
            {product.imageUrl ? (
              <img
                src={product.imageUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="pos-tile-letter" aria-hidden="true">
                {product.name.slice(0, 1)}
              </span>
            )}
            <span className="store-item-body">
              <strong>{product.name}</strong>
              {product.description && (
                <small className="muted">{product.description}</small>
              )}
              <span className="pos-tile-price">
                {product.variants.length > 1
                  ? `${formatMoney(Math.min(...product.variants.map((v) => v.price)))} +`
                  : formatMoney(product.variants[0]!.price)}
              </span>
            </span>
          </button>
        ))}
      </main>
      {count > 0 && (
        <button className="store-cart-bar" onClick={() => setCheckout(true)}>
          <span>
            {t.online.yourOrder} · {count}
          </span>
          <strong>{formatMoney(total)}</strong>
        </button>
      )}
      {picking && (
        <ProductDialog
          product={picking}
          menu={menu}
          onClose={() => setPicking(null)}
          onAdd={(line) => {
            setCart((lines) => [...lines, line]);
            setPicking(null);
          }}
        />
      )}
      <Dialog
        open={checkout}
        title={t.online.yourOrder}
        onClose={() => setCheckout(false)}
      >
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await post<{ trackingToken: string }>(
                '/public/orders',
                {
                  idempotencyKey: key.current,
                  source,
                  customerName: form.name,
                  ...(form.phone.trim()
                    ? { customerPhone: form.phone.trim() }
                    : {}),
                  ...(needsAddress ? { deliveryAddress: form.address } : {}),
                  note: form.note.trim() || null,
                  items: cart.map((line) => ({
                    variantId: line.variantId,
                    quantity: line.quantity,
                    modifierOptionIds: line.options.map((o) => o.id),
                  })),
                },
              );
              navigate(`/buyurtma/${result.trackingToken}`);
            } catch (caught) {
              setError(caught);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ul className="cart-lines">
            {cart.map((line) => (
              <li key={line.key}>
                <div className="cart-line-main">
                  <strong>{line.product.name}</strong>
                  <span className="muted small">
                    {line.options.map((option) => option.name).join(', ')}
                  </span>
                </div>
                <div className="stepper small">
                  <button
                    type="button"
                    aria-label={`${t.pos.decrease}: ${line.product.name}`}
                    onClick={() =>
                      setCart((lines) =>
                        line.quantity === 1
                          ? lines.filter((item) => item.key !== line.key)
                          : lines.map((item) =>
                              item.key === line.key
                                ? { ...item, quantity: item.quantity - 1 }
                                : item,
                            ),
                      )
                    }
                  >
                    −
                  </button>
                  <strong>{line.quantity}</strong>
                  <button
                    type="button"
                    aria-label={`${t.pos.increase}: ${line.product.name}`}
                    onClick={() =>
                      setCart((lines) =>
                        lines.map((item) =>
                          item.key === line.key
                            ? {
                                ...item,
                                quantity: Math.min(50, item.quantity + 1),
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                </div>
                <span className="cart-line-total">
                  {formatMoney(lineUnit(line) * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
          <div className="cart-total">
            <span>{t.pos.total}</span>
            <strong>{formatMoney(total)}</strong>
          </div>
          <TextField
            label={t.online.yourName}
            value={form.name}
            autoComplete="name"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            minLength={2}
            required
          />
          {needsContact && (
            <TextField
              label={t.online.yourPhone}
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+998 90 123 45 67"
              required
            />
          )}
          {needsAddress && (
            <TextField
              label={t.online.address}
              autoComplete="street-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              minLength={5}
              required
            />
          )}
          <TextField
            label={`${t.online.note} (${t.common.optional})`}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <p className="muted small">{t.online.payAtCounter}</p>
          <FormError error={error} />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            busy={busy}
            disabled={cart.length === 0}
          >
            {t.online.send}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

export function StoreUnavailable() {
  return (
    <div className="store">
      <div className="state">
        <h1>{t.online.unavailable}</h1>
        <p>{t.online.unavailableHint}</p>
      </div>
    </div>
  );
}
