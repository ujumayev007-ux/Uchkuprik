import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { can, useMe } from '../auth/session';
import { PaymentDialog } from '../components/PaymentDialog';
import { PrintReceipt } from '../components/PrintReceipt';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FormError,
  LoadingState,
  MoneyField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { parsePoint } from './DeliveryPricingCard';
import { api, ApiError, post } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useOrdering } from '../lib/ordering';
import { formatOrderNo } from '../lib/uzbek-number';
import {
  newKey,
  useCurrentShift,
  type Order,
  type OrderType,
} from '../lib/orders';
import { useZones } from './DeliveryPage';
import { OrderDetail } from './OrdersPage';
import { useFloor } from './FloorPage';
import {
  useMenu,
  type Menu,
  type ModifierGroup,
  type Product,
  type Variant,
} from './MenuPage';

type CartLine = {
  key: string;
  product: Product;
  variant: Variant;
  options: { id: string; name: string; price: number }[];
  quantity: number;
  note: string;
};

const unitTotal = (line: CartLine) =>
  line.variant.price +
  line.options.reduce((sum, option) => sum + option.price, 0);

function OptionsDialog({
  product,
  menu,
  onAdd,
  onClose,
}: {
  product: Product;
  menu: Menu;
  onAdd: (line: CartLine) => void;
  onClose: () => void;
}) {
  const variants = product.variants.filter((variant) => variant.available);
  const groups = product.modifierGroupIds
    .map((id) => menu.modifierGroups.find((group) => group.id === id))
    .filter((group): group is ModifierGroup => !!group && group.isActive);
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const valid = groups.every((group) => {
    const count = group.options.filter((option) =>
      selected.includes(option.id),
    ).length;
    return count >= group.minSelect && count <= group.maxSelect;
  });
  const variant = variants.find((item) => item.id === variantId);
  const options = groups
    .flatMap((group) => group.options)
    .filter((option) => selected.includes(option.id));

  return (
    <Dialog open title={product.name} onClose={onClose} wide>
      <div className="stack">
        {variants.length > 1 && (
          <fieldset>
            <legend>{t.pos.chooseSize}</legend>
            <div className="choice-grid">
              {variants.map((item) => (
                <button
                  key={item.id}
                  className={`choice ${variantId === item.id ? 'active' : ''}`}
                  aria-pressed={variantId === item.id}
                  onClick={() => setVariantId(item.id)}
                >
                  <span>{item.name}</span>
                  <strong>{formatMoney(item.price)}</strong>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {groups.map((group) => (
          <fieldset key={group.id}>
            <legend>
              {group.name}{' '}
              <small className="muted">
                (
                {group.minSelect > 0
                  ? `${t.pos.chooseAtLeast} ${group.minSelect}, `
                  : ''}
                {t.pos.chooseUpTo} {group.maxSelect})
              </small>
            </legend>
            <div className="choice-grid">
              {group.options
                .filter((option) => option.isActive)
                .map((option) => {
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
                          setSelected(
                            selected.filter((id) => id !== option.id),
                          );
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
              onClick={() => setQuantity(Math.min(999, quantity + 1))}
            >
              +
            </button>
          </div>
        </div>
        <TextField
          label={`${t.pos.note} (${t.common.optional})`}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button
          variant="primary"
          size="lg"
          disabled={!variant || !valid}
          onClick={() =>
            variant &&
            onAdd({
              key: newKey(),
              product,
              variant,
              options: options.map(({ id, name, price }) => ({
                id,
                name,
                price,
              })),
              quantity,
              note,
            })
          }
        >
          {t.pos.addToCart} ·{' '}
          {variant
            ? formatMoney(
                (variant.price +
                  options.reduce((sum, option) => sum + option.price, 0)) *
                  quantity,
              )
            : ''}
        </Button>
      </div>
    </Dialog>
  );
}

function ShiftGate() {
  const client = useQueryClient();
  const [cash, setCash] = useState<number | null>(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="shift-gate card">
      <h2>{t.pos.shiftClosed}</h2>
      <p className="muted">{t.pos.shiftClosedHint}</p>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/shifts/open', { openingCash: cash ?? 0 });
            await client.invalidateQueries({ queryKey: ['shift'] });
          } catch (caught) {
            setError(caught);
          } finally {
            setBusy(false);
          }
        }}
      >
        <MoneyField
          label={`${t.pos.openingCash} (${t.menu.sum})`}
          value={cash}
          onChange={setCash}
          required
        />
        <Button type="submit" variant="primary" busy={busy}>
          {t.pos.openShift}
        </Button>
      </form>
      <FormError error={error} />
    </div>
  );
}

export function PosPage() {
  const { data: me } = useMe();
  const branchId = me?.activeBranchId;
  const menu = useMenu(branchId);
  const floor = useFloor(branchId);
  const shift = useCurrentShift(can(me, 'shifts.manage'));
  const client = useQueryClient();
  const toast = useToast();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState<Product | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const ordering = useOrdering();
  const navigate = useNavigate();
  const allowedTypes = (['TAKEAWAY', 'DINE_IN', 'DELIVERY'] as const).filter(
    (value) => ordering.types[value],
  );
  const [type, setType] = useState<OrderType>(allowedTypes[0] ?? 'TAKEAWAY');
  const [tableId, setTableId] = useState('');
  // Adding items to an existing order: /kassa?buyurtma=<orderId>.
  const [addToId, setAddToId] = useState<string | null>(null);
  // Waiter panel opens the POS for a table: /kassa?stol=<tableId>.
  // The «Mijoz» button of the Orders section opens it as /kassa?mijoz=1.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const table = params.get('stol');
    if (table) {
      setType('DINE_IN');
      setTableId(table);
    }
    if (params.get('mijoz')) {
      setType('DINE_IN');
      setTableId('');
    }
    setAddToId(params.get('buyurtma'));
  }, []);
  // Reopening a table restores its active order (one per table, kept in the database
  // until it is paid and closed), so items are added to it instead of a duplicate.
  const tableOrder = useQuery({
    queryKey: ['orders', 'table-active', tableId],
    queryFn: () =>
      api<{ orders: Order[] }>(`/orders?scope=active&tableId=${tableId}`).then(
        (data) =>
          data.orders.find((order) => order.total > 0 && order.due > 0) ?? null,
      ),
    enabled:
      ordering.singleOrderPerTable &&
      type === 'DINE_IN' &&
      !!tableId &&
      !addToId,
  });
  const restoredId = !addToId ? (tableOrder.data?.id ?? null) : null;
  const targetId = addToId ?? restoredId;
  const [viewing, setViewing] = useState(false);
  const addTo = useQuery({
    queryKey: ['orders', 'one', targetId],
    queryFn: () => api<Order>(`/orders/${targetId}`),
    enabled: !!targetId,
  });
  const [customer, setCustomer] = useState({
    name: '',
    phone: '',
    address: '',
    landmark: '',
    point: '',
  });
  const [paying, setPaying] = useState<Order | null>(null);
  // Optional loyalty customer and promo code applied right after the order is created.
  const [extras, setExtras] = useState({ phone: '', promo: '' });
  const [zoneId, setZoneId] = useState('');
  const zones = useZones(branchId);
  const [result, setResult] = useState<{
    order: Order;
    change: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Phones: the cart is a full-screen sheet opened from the bottom bar.
  const [cartOpen, setCartOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One idempotency key per cart, so a retried submit cannot create two orders.
  const cartKey = useRef(newKey());

  useEffect(() => {
    if (cart.length === 0) cartKey.current = newKey();
  }, [cart.length]);

  const products = useMemo(
    () =>
      (menu.data?.products ?? []).filter(
        (product) =>
          product.variants.some((variant) => variant.available) &&
          (!categoryId || product.categoryId === categoryId) &&
          `${product.name} ${product.sku ?? ''} ${product.barcode ?? ''}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [menu.data, categoryId, query],
  );
  const subtotal = cart.reduce(
    (sum, line) => sum + unitTotal(line) * line.quantity,
    0,
  );
  const tables = (floor.data?.rooms ?? []).flatMap((room) =>
    room.tables.map((table) => ({ ...table, room: room.name })),
  );
  const needsShift = can(me, 'payments.accept') && shift.data === null;
  const guestMode = type === 'DINE_IN' && !tableId;

  const addProduct = (product: Product) => {
    const available = product.variants.filter((variant) => variant.available);
    if (available.length === 1 && product.modifierGroupIds.length === 0) {
      const variant = available[0]!;
      setCart((lines) => {
        const same = lines.find(
          (line) =>
            line.variant.id === variant.id &&
            line.options.length === 0 &&
            !line.note,
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
            variant,
            options: [],
            quantity: 1,
            note: '',
          },
        ];
      });
    } else setPicking(product);
  };

  const submit = async (place: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (targetId) {
        const updated = await post<Order>(`/orders/${targetId}/items`, {
          items: cart.map((line) => ({
            variantId: line.variant.id,
            quantity: line.quantity,
            modifierOptionIds: line.options.map((option) => option.id),
            note: line.note || null,
          })),
        });
        setCart([]);
        await client.invalidateQueries({ queryKey: ['orders'] });
        toast(`${t.ordering.itemsAdded} ${formatOrderNo(updated.number)}`);
        navigate('/buyurtmalar');
        return;
      }
      const order = await post<Order>('/orders', {
        idempotencyKey: cartKey.current,
        type,
        tableId: type === 'DINE_IN' && tableId ? tableId : null,
        customerName: customer.name.trim() || null,
        customerPhone: customer.phone.trim() || null,
        deliveryAddress:
          type === 'DELIVERY' ? customer.address.trim() || null : null,
        deliveryLandmark:
          type === 'DELIVERY' ? customer.landmark.trim() || null : null,
        place,
        items: cart.map((line) => ({
          variantId: line.variant.id,
          quantity: line.quantity,
          modifierOptionIds: line.options.map((option) => option.id),
          note: line.note || null,
        })),
      });
      setCart([]);
      setCustomer({
        name: '',
        phone: '',
        address: '',
        landmark: '',
        point: '',
      });
      let current = order;
      const loyaltyPhone =
        extras.phone.trim() ||
        (type === 'DELIVERY' ? customer.phone.trim() : '');
      try {
        if (loyaltyPhone)
          await post(`/orders/${order.id}/customer`, {
            phone: loyaltyPhone,
            name: customer.name.trim() || null,
          });
        if (extras.promo.trim())
          await post(`/orders/${order.id}/coupon`, {
            code: extras.promo.trim(),
          });
        if (type === 'DELIVERY' && zoneId)
          await post(`/orders/${order.id}/delivery-zone`, { zoneId });
        const point = type === 'DELIVERY' ? parsePoint(customer.point) : null;
        if (point) await post(`/orders/${order.id}/delivery-location`, point);
      } catch (caught) {
        // The order exists; the cashier can still take payment without the extra.
        toast(
          caught instanceof Error ? caught.message : t.common.errorTitle,
          'error',
        );
      }
      if (
        loyaltyPhone ||
        extras.promo.trim() ||
        (type === 'DELIVERY' && zoneId)
      )
        current = await api<Order>(`/orders/${order.id}`);
      setExtras({ phone: '', promo: '' });
      await client.invalidateQueries({ queryKey: ['orders'] });
      if (place)
        toast(
          `${t.pos.orderSent} ${formatOrderNo(current.number)}${
            type === 'DINE_IN' && !current.table
              ? ` · ${t.ordering.noTable}`
              : ''
          }`,
        );
      else setPaying(current);
    } catch (caught) {
      setError(caught);
      // Another device opened the table first: restore its order instead.
      if (caught instanceof ApiError && caught.code === 'TABLE_HAS_ORDER')
        await client.invalidateQueries({
          queryKey: ['orders', 'table-active'],
        });
    } finally {
      setBusy(false);
    }
  };

  if (!branchId) return <EmptyState title={t.nav.selectBranch} />;
  if (menu.isPending) return <LoadingState />;
  if (menu.error)
    return (
      <ErrorState error={menu.error} onRetry={() => void menu.refetch()} />
    );

  const categories = menu.data.categories.filter((category) =>
    menu.data.products.some((product) => product.categoryId === category.id),
  );

  return (
    <div className="pos">
      <section className="pos-catalog" aria-label={t.nav.menu}>
        <div className="pos-toolbar">
          <input
            type="search"
            className="search"
            placeholder={t.common.search}
            aria-label={t.common.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="chip-row" role="tablist" aria-label={t.menu.categories}>
          <button
            role="tab"
            aria-selected={!categoryId}
            className={`chip ${!categoryId ? 'active' : ''}`}
            onClick={() => setCategoryId(null)}
          >
            {t.common.all}
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              role="tab"
              aria-selected={categoryId === category.id}
              className={`chip ${categoryId === category.id ? 'active' : ''}`}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>
        {products.length === 0 ? (
          <EmptyState title={t.menu.noProducts} />
        ) : (
          <div className="pos-grid">
            {products.map((product) => {
              const prices = product.variants
                .filter((variant) => variant.available)
                .map((variant) => variant.price);
              return (
                <button
                  key={product.id}
                  className="pos-tile"
                  onClick={() => addProduct(product)}
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
                  <span className="pos-tile-name">{product.name}</span>
                  <span className="pos-tile-price">
                    {prices.length > 1
                      ? `${formatMoney(Math.min(...prices))} +`
                      : formatMoney(prices[0] ?? 0)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <button
        type="button"
        className="pos-cartbar"
        onClick={() => setCartOpen(true)}
      >
        <span>
          🛒 {t.pos.cart}
          {cart.length > 0
            ? ` · ${cart.reduce((sum, line) => sum + line.quantity, 0)}`
            : ''}
        </span>
        <span>{formatMoney(subtotal)}</span>
      </button>
      <aside
        className={`pos-cart ${cartOpen ? 'open' : ''}`}
        aria-label={t.pos.cart}
      >
        <button
          type="button"
          className="btn btn-ghost btn-md pos-cart-close"
          onClick={() => setCartOpen(false)}
        >
          ✕ {t.common.close}
        </button>
        {needsShift && <ShiftGate />}
        {targetId && (
          <div className="guest-waiting" role="status">
            <strong>
              {t.ordering.addingTo}
              {addTo.data ? `: ${formatOrderNo(addTo.data.number)}` : ''}
            </strong>
            {addTo.data?.table && <span>{addTo.data.table.name}</span>}
            {addTo.data && (
              <span className="muted small">
                {t.pos.total}: {formatMoney(addTo.data.total)} · {t.pos.due}:{' '}
                {formatMoney(addTo.data.due)}
              </span>
            )}
            <div className="form-actions">
              <Button size="sm" onClick={() => setViewing(true)}>
                {t.ordering.viewOrder}
              </Button>
              {addToId && (
                <button
                  className="text-link"
                  onClick={() => {
                    setAddToId(null);
                    navigate('/kassa', { replace: true });
                  }}
                >
                  {t.common.cancel}
                </button>
              )}
            </div>
          </div>
        )}
        {!targetId && (
          <div
            className="segmented"
            role="radiogroup"
            aria-label={t.orders.type}
          >
            {allowedTypes.map((value) => (
              <button
                key={value}
                role="radio"
                aria-checked={
                  type === value && !(value === 'DINE_IN' && guestMode)
                }
                className={
                  type === value && !(value === 'DINE_IN' && guestMode)
                    ? 'active'
                    : ''
                }
                onClick={() => setType(value)}
              >
                {t.pos.types[value]}
              </button>
            ))}
            {ordering.walkin && ordering.types.DINE_IN && (
              <button
                role="radio"
                aria-checked={guestMode}
                className={guestMode ? 'active' : ''}
                title={t.ordering.guestHint}
                onClick={() => {
                  setType('DINE_IN');
                  setTableId('');
                }}
              >
                {t.ordering.guest}
              </button>
            )}
          </div>
        )}
        {!targetId && guestMode && (
          <p className="guest-waiting" role="status">
            <strong>{t.ordering.noTable}</strong>
            <span className="muted small">{t.ordering.guestHint}</span>
          </p>
        )}
        {!addToId && type === 'DINE_IN' && (
          <label className="field">
            <span className="field-label">{t.pos.table}</span>
            <select
              value={tableId}
              onChange={(e) => setTableId(e.target.value)}
              aria-label={t.pos.table}
            >
              {ordering.walkin && (
                <option value="">{t.ordering.noTable}</option>
              )}
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.room} · {table.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!targetId && type === 'DELIVERY' && (
          <div className="stack compact">
            <TextField
              label={t.pos.customerPhone}
              type="tel"
              value={customer.phone}
              onChange={(e) =>
                setCustomer({ ...customer, phone: e.target.value })
              }
              required
            />
            <TextField
              label={t.pos.deliveryAddress}
              value={customer.address}
              onChange={(e) =>
                setCustomer({ ...customer, address: e.target.value })
              }
              required
            />
            <TextField
              label={t.deliverySheet.landmark}
              value={customer.landmark}
              onChange={(e) =>
                setCustomer({ ...customer, landmark: e.target.value })
              }
            />
            <TextField
              label={t.deliveryGps.customerPoint}
              hint={t.deliveryGps.pointHint}
              value={customer.point}
              onChange={(e) =>
                setCustomer({ ...customer, point: e.target.value })
              }
            />
            {(zones.data ?? []).some((zone) => zone.isActive) && (
              <label className="field">
                <span className="field-label">{t.delivery.zone}</span>
                <select
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                  aria-label={t.delivery.zone}
                >
                  <option value="">{t.delivery.noZone}</option>
                  {(zones.data ?? [])
                    .filter((zone) => zone.isActive)
                    .map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name} (+{formatMoney(zone.fee)})
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
        )}
        {!targetId && (
          <details className="cart-extras">
            <summary>
              {t.crm.customerPhone} · {t.crm.promoCode}
            </summary>
            <div className="stack compact">
              <TextField
                label={`${t.crm.customerPhone} (${t.common.optional})`}
                type="tel"
                value={extras.phone}
                onChange={(e) =>
                  setExtras({ ...extras, phone: e.target.value })
                }
              />
              <TextField
                label={`${t.crm.promoCode} (${t.common.optional})`}
                value={extras.promo}
                onChange={(e) =>
                  setExtras({ ...extras, promo: e.target.value.toUpperCase() })
                }
              />
            </div>
          </details>
        )}
        <h2 className="cart-title">{t.pos.cart}</h2>
        {cart.length === 0 ? (
          <p className="muted center cart-empty">{t.pos.emptyCart}</p>
        ) : (
          <ul className="cart-lines">
            {cart.map((line) => (
              <li key={line.key}>
                <div className="cart-line-main">
                  <strong>{line.product.name}</strong>
                  <span className="muted small">
                    {line.variant.name}
                    {line.options.map((option) => ` · ${option.name}`).join('')}
                    {line.note && ` · ${line.note}`}
                  </span>
                </div>
                <div className="stepper small">
                  <button
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
                    aria-label={`${t.pos.increase}: ${line.product.name}`}
                    onClick={() =>
                      setCart((lines) =>
                        lines.map((item) =>
                          item.key === line.key
                            ? {
                                ...item,
                                quantity: Math.min(999, item.quantity + 1),
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
                  {formatMoney(unitTotal(line) * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="cart-footer">
          <div className="cart-total">
            <span>{t.pos.total}</span>
            <strong>{formatMoney(subtotal)}</strong>
          </div>
          <FormError error={error} />
          <div className="cart-actions">
            <Button disabled={cart.length === 0} onClick={() => setCart([])}>
              {t.pos.clear}
            </Button>
            <Button
              disabled={cart.length === 0}
              busy={busy}
              onClick={() => void submit(true)}
            >
              {t.pos.addOrder}
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={
                cart.length === 0 ||
                !can(me, 'payments.accept') ||
                needsShift ||
                !!targetId
              }
              busy={busy}
              onClick={() => void submit(false)}
            >
              {t.pos.pay}
            </Button>
          </div>
        </div>
      </aside>

      {picking && menu.data && (
        <OptionsDialog
          product={picking}
          menu={menu.data}
          onClose={() => setPicking(null)}
          onAdd={(line) => {
            setCart((lines) => [...lines, line]);
            setPicking(null);
          }}
        />
      )}
      {viewing && targetId && (
        <OrderDetail orderId={targetId} onClose={() => setViewing(false)} />
      )}
      {paying && (
        <PaymentDialog
          order={paying}
          onClose={() => setPaying(null)}
          onPaid={(order, change) => {
            setPaying(null);
            setResult({ order, change });
          }}
        />
      )}
      {result && (
        <Dialog open title={t.payment.done} onClose={() => setResult(null)}>
          <div className="stack center">
            <p className="order-number">
              {t.orders.number}
              {result.order.number}
            </p>
            {result.change !== null && result.change > 0 && (
              <div className="change big" role="status">
                <span>{t.payment.giveChange}</span>
                <strong>{formatMoney(result.change)}</strong>
              </div>
            )}
            <div className="form-actions center">
              <PrintReceipt orderId={result.order.id} />
              <Button variant="primary" onClick={() => setResult(null)}>
                {t.payment.newOrder}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
