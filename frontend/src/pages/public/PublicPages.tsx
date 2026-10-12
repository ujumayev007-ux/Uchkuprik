import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, FormError, TextField } from '../../components/ui';
import { useParams } from 'react-router';
import { LoadingState } from '../../components/ui';
import { t } from '../../i18n';
import { api, post } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import { Storefront, StoreUnavailable, type PublicMenu } from './Storefront';

/** Table QR menu: /t/:token */
export function TableMenuPage() {
  const { token } = useParams();
  const data = useQuery({
    queryKey: ['public', 'table', token],
    queryFn: () =>
      api<{
        restaurant: { name: string };
        branch: { id: string; name: string };
        table: { name: string; room: string };
        menu: PublicMenu;
      }>(`/public/t/${token}`),
    retry: false,
  });
  if (data.isPending) return <LoadingState />;
  if (data.error) return <StoreUnavailable />;
  const { restaurant, branch, table, menu } = data.data;
  return (
    <Storefront
      title={restaurant.name}
      subtitle={`${branch.name} · ${t.online.table} ${table.name}`}
      menu={menu}
      source={{ kind: 'table', token }}
      needsContact={false}
      needsAddress={false}
    />
  );
}

/** Restaurant website ordering: /r/:slug */
export function WebsiteMenuPage() {
  const { slug } = useParams();
  const info = useQuery({
    queryKey: ['public', 'store', slug],
    queryFn: () =>
      api<{
        name: string;
        phone: string | null;
        branches: { id: string; name: string; address: string | null }[];
      }>(`/public/r/${slug}`),
    retry: false,
  });
  const [branchId, setBranchId] = useState<string | null>(null);
  const [type, setType] = useState<'TAKEAWAY' | 'DELIVERY'>('TAKEAWAY');
  const [zoneId, setZoneId] = useState('');
  const branch = branchId ?? info.data?.branches[0]?.id ?? null;
  const menu = useQuery({
    queryKey: ['public', 'menu', slug, branch],
    queryFn: () => api<PublicMenu>(`/public/r/${slug}/menu?branchId=${branch}`),
    enabled: !!branch,
    retry: false,
  });
  if (info.isPending || (branch && menu.isPending)) return <LoadingState />;
  if (info.error || menu.error || !branch || !menu.data)
    return <StoreUnavailable />;
  return (
    <Storefront
      key={`${branch}-${type}`}
      title={info.data.name}
      subtitle={info.data.phone ?? undefined}
      menu={menu.data}
      source={{
        kind: 'web',
        slug,
        branchId: branch,
        type,
        ...(type === 'DELIVERY' && (zoneId || menu.data.zones?.[0]?.id)
          ? { zoneId: zoneId || menu.data.zones![0]!.id }
          : {}),
      }}
      needsContact
      needsAddress={type === 'DELIVERY'}
      header={
        <div className="store-options">
          {info.data.branches.length > 1 && (
            <label className="field">
              <span className="field-label">{t.online.chooseBranch}</span>
              <select
                value={branch}
                onChange={(event) => setBranchId(event.target.value)}
              >
                {info.data.branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.address ? ` — ${item.address}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div
            className="segmented"
            role="radiogroup"
            aria-label={t.orders.type}
          >
            {(['TAKEAWAY', 'DELIVERY'] as const).map((value) => (
              <button
                key={value}
                role="radio"
                aria-checked={type === value}
                className={type === value ? 'active' : ''}
                onClick={() => setType(value)}
              >
                {t.online.types[value]}
              </button>
            ))}
          </div>
          {type === 'DELIVERY' && (menu.data.zones?.length ?? 0) > 0 && (
            <label className="field">
              <span className="field-label">{t.delivery.zone}</span>
              <select
                value={zoneId || menu.data.zones![0]!.id}
                onChange={(event) => setZoneId(event.target.value)}
              >
                {menu.data.zones!.map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.name} — {t.delivery.fee}: {formatMoney(zone.fee)}
                    {zone.minOrder > 0
                      ? ` · ${t.delivery.zoneMinOrderHint}: ${formatMoney(zone.minOrder)}`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      }
    />
  );
}

type Tracking = {
  number: number;
  status: string;
  type: string;
  branch: { name: string; phone: string | null };
  table: string | null;
  createdAt: string;
  cancelReason: string | null;
  items: {
    name: string;
    variant: string;
    modifiers: string[];
    quantity: number;
    lineTotal: number;
  }[];
  subtotal: number;
  discountTotal: number;
  serviceCharge: number;
  total: number;
  paid: number;
};

const steps = ['PENDING', 'PLACED', 'PREPARING', 'READY', 'SERVED'];

function FeedbackForm({ token }: { token: string }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (sent) return <p className="notice">{t.crm.thanks}</p>;
  return (
    <form
      className="card stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await post(`/public/orders/${token}/feedback`, {
            rating,
            comment: comment.trim() || null,
          });
          setSent(true);
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <h2>{t.crm.rateTitle}</h2>
      <p className="muted small">{t.crm.rateHint}</p>
      <div className="stars" role="radiogroup" aria-label={t.crm.rating}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={String(value)}
            className={value <= rating ? 'on' : ''}
            onClick={() => setRating(value)}
          >
            ★
          </button>
        ))}
      </div>
      <TextField
        label={`${t.crm.comment} (${t.common.optional})`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <FormError error={error} />
      <Button type="submit" variant="primary" disabled={rating === 0}>
        {t.common.save}
      </Button>
    </form>
  );
}

/** Customer order tracking: /buyurtma/:token (polls every 10 seconds). */
export function TrackingPage() {
  const { token } = useParams();
  const order = useQuery({
    queryKey: ['public', 'tracking', token],
    queryFn: () => api<Tracking>(`/public/orders/${token}`),
    refetchInterval: (query) =>
      ['COMPLETED', 'CANCELLED'].includes(query.state.data?.status ?? '')
        ? false
        : 10_000,
    retry: false,
  });
  // Hosted Payme/Click checkout; the order is marked paid only by verified callbacks.
  const payLinks = useQuery({
    queryKey: ['public', 'pay', token, order.data?.paid],
    queryFn: () =>
      api<{
        due: number;
        links: { provider: 'PAYME' | 'CLICK'; url: string }[];
      }>(`/public/orders/${token}/pay`),
    enabled:
      !!order.data && !['CANCELLED', 'COMPLETED'].includes(order.data.status),
    retry: false,
  });
  if (order.isPending) return <LoadingState />;
  if (order.error) return <StoreUnavailable />;
  const o = order.data;
  const current =
    o.status === 'COMPLETED' ? steps.length : steps.indexOf(o.status);
  return (
    <div className="store track">
      <header className="store-header">
        <div>
          <h1>{t.online.trackTitle}</h1>
          <p className="muted">{o.branch.name}</p>
        </div>
      </header>
      <section className="card track-card">
        <p className="muted">{t.online.number}</p>
        <p className="order-number">№{o.number}</p>
        {o.status === 'CANCELLED' ? (
          <p className="form-error">
            {t.online.cancelledHint}
            {o.cancelReason ? `: ${o.cancelReason}` : ''}
          </p>
        ) : (
          <>
            <ol className="track-steps">
              {steps.map((step, index) => (
                <li
                  key={step}
                  className={
                    index < current
                      ? 'done'
                      : index === current
                        ? 'current'
                        : ''
                  }
                >
                  {t.online.steps[step]}
                </li>
              ))}
            </ol>
            <p className="track-hint" role="status">
              {o.status === 'PENDING'
                ? t.online.pendingHint
                : o.status === 'READY'
                  ? t.online.readyHint
                  : t.online.steps[o.status]}
            </p>
          </>
        )}
      </section>
      {payLinks.data && payLinks.data.links.length > 0 && (
        <section className="card stack">
          <h2>{t.payments.payOnline}</h2>
          {payLinks.data.links.map((link) => (
            <a
              key={link.provider}
              className="btn btn-primary btn-lg"
              href={link.url}
            >
              {t.payments.payWith.replace(
                '{p}',
                t.payment.methods[link.provider],
              )}
            </a>
          ))}
        </section>
      )}
      {['READY', 'SERVED', 'COMPLETED'].includes(o.status) && (
        <FeedbackForm token={token!} />
      )}
      <section className="card">
        <ul className="plain-list">
          {o.items.map((item, index) => (
            <li key={index} className="track-line">
              <span>
                {item.quantity} × {item.name}
                {item.variant !== 'Standart' && ` (${item.variant})`}
                {item.modifiers.length > 0 && (
                  <small className="muted block">
                    + {item.modifiers.join(', ')}
                  </small>
                )}
              </span>
              <span>{formatMoney(item.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <div className="cart-total">
          <span>{t.pos.total}</span>
          <strong>{formatMoney(o.total)}</strong>
        </div>
        <p className="muted small">
          {formatDateTime(o.createdAt)} · {t.online.autoRefresh}
        </p>
      </section>
    </div>
  );
}
