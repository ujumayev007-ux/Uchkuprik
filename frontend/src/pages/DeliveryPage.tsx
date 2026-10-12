import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '../auth/session';
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
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, patch, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

export type Zone = {
  id: string;
  name: string;
  fee: number;
  minOrder: number;
  etaMinutes: number | null;
  isActive: boolean;
};
type BoardOrder = {
  id: string;
  number: number;
  status: string;
  deliveryStatus: string;
  courierId: string | null;
  zone: string | null;
  address: string | null;
  customerName: string | null;
  customerPhone: string | null;
  total: number;
  due: number;
  createdAt: string;
  failReason: string | null;
};
type Courier = {
  id: string;
  name: string;
  active: number;
  location: { lat: number; lng: number; at: string } | null;
};

export function useZones(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['delivery', 'zones', branchId],
    queryFn: () =>
      api<{ zones: Zone[] }>(`/delivery/zones?branchId=${branchId}`).then(
        (data) => data.zones,
      ),
    enabled: !!branchId,
  });
}

const tone: Record<
  string,
  'neutral' | 'warning' | 'accent' | 'success' | 'danger'
> = {
  UNASSIGNED: 'warning',
  ASSIGNED: 'accent',
  PICKED_UP: 'accent',
  DELIVERED: 'success',
  FAILED: 'danger',
};
export const mapLink = (lat: number, lng: number) =>
  `https://yandex.uz/maps/?pt=${lng},${lat}&z=16&l=map`;

function Board() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const zones = useZones(me?.activeBranchId);
  const board = useQuery({
    queryKey: ['orders', 'delivery-board', me?.activeBranchId],
    queryFn: () =>
      api<{ orders: BoardOrder[]; couriers: Courier[] }>('/delivery/board'),
    enabled: !!me?.activeBranchId,
    refetchInterval: 30_000,
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: ['orders'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  if (board.isPending) return <LoadingState />;
  if (board.error) return <ErrorState error={board.error} />;
  const { orders, couriers } = board.data;
  return (
    <div className="stack">
      <section className="card">
        <h2>{t.delivery.couriers}</h2>
        <div className="courier-chips">
          {couriers.length === 0 && (
            <span className="muted">{t.common.emptyTitle}</span>
          )}
          {couriers.map((courier) => (
            <span key={courier.id} className="station-chip">
              {courier.name} · {courier.active}
              {courier.location ? (
                <a
                  className="text-link inline"
                  href={mapLink(courier.location.lat, courier.location.lng)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.delivery.showOnMap}
                </a>
              ) : (
                <small className="muted">{t.delivery.noLocation}</small>
              )}
            </span>
          ))}
        </div>
      </section>
      {orders.length === 0 ? (
        <EmptyState title={t.delivery.noDeliveries} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.orders.number}</th>
                <th>{t.common.address}</th>
                <th>{t.delivery.zone}</th>
                <th>{t.delivery.courier}</th>
                <th>{t.common.status}</th>
                <th className="right">{t.delivery.due}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>
                    <strong>
                      {t.orders.number}
                      {order.number}
                    </strong>
                    <small className="muted block">
                      {formatDateTime(order.createdAt)}
                    </small>
                  </td>
                  <td>
                    {order.address}
                    <small className="muted block">
                      {[order.customerName, order.customerPhone]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </td>
                  <td>
                    <select
                      aria-label={`${t.delivery.zone} ${order.number}`}
                      value={
                        (zones.data ?? []).find(
                          (zone) => zone.name === order.zone,
                        )?.id ?? ''
                      }
                      onChange={(event) =>
                        void act(() =>
                          post(`/orders/${order.id}/delivery-zone`, {
                            zoneId: event.target.value || null,
                          }),
                        )
                      }
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
                  </td>
                  <td>
                    <select
                      aria-label={`${t.delivery.courier} ${order.number}`}
                      value={order.courierId ?? ''}
                      disabled={
                        order.deliveryStatus === 'PICKED_UP' ||
                        order.deliveryStatus === 'DELIVERED'
                      }
                      onChange={(event) =>
                        void act(() =>
                          post(`/orders/${order.id}/courier`, {
                            courierId: event.target.value || null,
                          }),
                        )
                      }
                    >
                      <option value="">{t.delivery.noCourier}</option>
                      {couriers.map((courier) => (
                        <option key={courier.id} value={courier.id}>
                          {courier.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Badge tone={tone[order.deliveryStatus] ?? 'neutral'}>
                      {t.delivery.statuses[order.deliveryStatus]}
                    </Badge>
                    <small className="muted block">
                      {t.orders.statuses[order.status as 'PLACED']}
                    </small>
                    {order.failReason && (
                      <small className="danger-text block">
                        {order.failReason}
                      </small>
                    )}
                  </td>
                  <td className="right nowrap">
                    {order.due > 0 ? (
                      <strong>{formatMoney(order.due)}</strong>
                    ) : (
                      t.delivery.paid
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ZoneForm({
  zone,
  branchId,
  onDone,
}: {
  zone: Zone | null;
  branchId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    name: zone?.name ?? '',
    fee: zone?.fee ?? null,
    minOrder: zone?.minOrder ?? 0,
    eta: zone?.etaMinutes?.toString() ?? '',
    isActive: zone?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const body = {
          branchId,
          name: form.name,
          fee: form.fee ?? 0,
          minOrder: form.minOrder ?? 0,
          etaMinutes: form.eta ? Number(form.eta) : null,
          isActive: form.isActive,
        };
        try {
          if (zone) await patch(`/delivery/zones/${zone.id}`, body);
          else await post('/delivery/zones', body);
          onDone();
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <TextField
        label={t.common.name}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        required
      />
      <MoneyField
        label={`${t.delivery.fee} (${t.menu.sum})`}
        value={form.fee}
        onChange={(fee) => setForm({ ...form, fee })}
        required
      />
      <MoneyField
        label={`${t.delivery.minOrder} (${t.menu.sum})`}
        value={form.minOrder}
        onChange={(minOrder) => setForm({ ...form, minOrder: minOrder ?? 0 })}
      />
      <TextField
        label={`${t.delivery.eta} (${t.common.optional})`}
        type="number"
        min={1}
        max={600}
        value={form.eta}
        onChange={(e) => setForm({ ...form, eta: e.target.value })}
      />
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
      />
      <FormError error={error} />
      <Button type="submit" variant="primary">
        {t.common.save}
      </Button>
    </form>
  );
}

function Zones() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const zones = useZones(me?.activeBranchId);
  const [editing, setEditing] = useState<Zone | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setEditing('new')}>
          + {t.delivery.addZone}
        </Button>
      </div>
      {zones.data && zones.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.common.name}</th>
                <th className="right">{t.delivery.fee}</th>
                <th className="right">{t.delivery.minOrder}</th>
                <th className="right">{t.delivery.eta}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zones.data.map((zone) => (
                <tr
                  key={zone.id}
                  className={zone.isActive ? '' : 'is-inactive'}
                >
                  <td>{zone.name}</td>
                  <td className="right">{formatMoney(zone.fee)}</td>
                  <td className="right">{formatMoney(zone.minOrder)}</td>
                  <td className="right">{zone.etaMinutes ?? '—'}</td>
                  <td className="right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(zone)}
                    >
                      {t.common.edit}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
      <Dialog
        open={editing !== null}
        title={editing === 'new' ? t.delivery.addZone : t.common.edit}
        onClose={() => setEditing(null)}
      >
        {editing !== null && me?.activeBranchId && (
          <ZoneForm
            zone={editing === 'new' ? null : editing}
            branchId={me.activeBranchId}
            onDone={async () => {
              setEditing(null);
              await client.invalidateQueries({
                queryKey: ['delivery', 'zones'],
              });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function Report() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const report = useQuery({
    queryKey: ['delivery', 'report', from, to],
    queryFn: () =>
      api<{
        couriers: {
          courierId: string;
          name: string;
          delivered: number;
          failed: number;
          deliveryFees: number;
          averageMinutes: number | null;
        }[];
      }>(`/delivery/report?from=${from}&to=${to}`).then(
        (data) => data.couriers,
      ),
  });
  return (
    <div className="stack">
      <div className="toolbar">
        <TextField
          label={t.reports.from}
          type="date"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField
          label={t.reports.to}
          type="date"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      {report.data && report.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.delivery.courier}</th>
                <th className="right">{t.delivery.delivered}</th>
                <th className="right">{t.delivery.failed}</th>
                <th className="right">{t.delivery.fees}</th>
                <th className="right">{t.delivery.avgMinutes}</th>
              </tr>
            </thead>
            <tbody>
              {report.data.map((row) => (
                <tr key={row.courierId}>
                  <td>{row.name}</td>
                  <td className="right">{row.delivered}</td>
                  <td className="right">{row.failed}</td>
                  <td className="right">{formatMoney(row.deliveryFees)}</td>
                  <td className="right">{row.averageMinutes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

type Tab = 'board' | 'zones' | 'report';

export function DeliveryPage() {
  const [tab, setTab] = useState<Tab>('board');
  return (
    <>
      <PageHeader title={t.delivery.title} subtitle={t.delivery.subtitle} />
      <div className="tabs" role="tablist">
        {(['board', 'zones', 'report'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {t.delivery.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'board' && <Board />}
      {tab === 'zones' && <Zones />}
      {tab === 'report' && <Report />}
    </>
  );
}
