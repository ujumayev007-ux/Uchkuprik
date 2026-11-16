import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { can, useMe } from '../auth/session';
import { DisplayModeSwitch, OrderBoard } from '../components/OrderBoard';
import { whereOf } from '../components/ReadyAlerts';
import { TableAssignDialog } from '../components/TableAssignDialog';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { useOrderDisplayMode, useOrdering } from '../lib/ordering';
import type { Order } from '../lib/orders';
import { OrderDetail } from './OrdersPage';

type Floor = {
  rooms: {
    id: string;
    name: string;
    tables: { id: string; name: string; seats: number }[];
  }[];
};

type ReadyRow = {
  id: string;
  orderId: string;
  number: number;
  table: string | null;
  name: string;
  quantity: number;
  readyAt: string;
};

const hasReady = (order: Order) =>
  order.items.some(
    (item) => item.status === 'ACTIVE' && item.kitchenStatus === 'READY',
  );

/** «Tayyor»: this waiter's dishes waiting at the kitchen pass, grouped by order. */
function ReadySection({ highlight }: { highlight: Set<string> }) {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const ready = useQuery({
    queryKey: ['waiter-ready'],
    queryFn: () =>
      api<{ items: ReadyRow[] }>('/waiter/ready-items').then((d) => d.items),
    refetchInterval: 20_000,
  });
  const rows = ready.data ?? [];
  const groups = new Map<string, ReadyRow[]>();
  for (const row of rows)
    groups.set(row.orderId, [...(groups.get(row.orderId) ?? []), row]);

  const pickUp = async (orderId: string, itemIds: string[]) => {
    if (busy) return;
    setBusy(orderId);
    try {
      await post(`/orders/${orderId}/items/picked-up`, { itemIds });
      toast(t.waiter.pickedUp);
      await client.invalidateQueries({ queryKey: ['waiter-ready'] });
      await client.invalidateQueries({ queryKey: ['orders'] });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ready-section stack" aria-live="polite">
      <h2 className="section-title">
        ✅ {t.waiter.ready} ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="muted small">{t.waiter.noReady}</p>
      ) : (
        <>
          <p className="muted small">{t.waiter.readyHint}</p>
          {[...groups].map(([orderId, items]) => (
            <div key={orderId} className="ready-card">
              <strong className="ready-card-title">
                {whereOf(items[0]!.table, items[0]!.number)}
              </strong>
              <ul className="ready-list">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className={highlight.has(item.id) ? 'is-highlight' : ''}
                  >
                    <span>
                      <strong>{item.quantity} ×</strong> {item.name}
                    </span>
                    <Button
                      size="sm"
                      busy={busy === orderId}
                      onClick={() => void pickUp(orderId, [item.id])}
                    >
                      {t.waiter.pickedUp}
                    </Button>
                  </li>
                ))}
              </ul>
              {items.length > 1 && (
                <Button
                  variant="primary"
                  busy={busy === orderId}
                  onClick={() =>
                    void pickUp(
                      orderId,
                      items.map((item) => item.id),
                    )
                  }
                >
                  {t.waiter.pickedUpAll}
                </Button>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/**
 * Waiter panel, tables first: each table shows its state in words and colour
 * («Bo‘sh», «Buyurtma ochiq», «Tayyor taom bor»); a free table opens the menu for a
 * new order, a busy one its orders. «Tayyor» lists the dishes waiting to be taken.
 * Opened from a ready alert (?buyurtma=…&tayyor=…) the order opens with those
 * dishes highlighted.
 */
export function WaiterPage() {
  const { data: me } = useMe();
  const ordering = useOrdering();
  const navigate = useNavigate();
  const view = useOrderDisplayMode();
  const branchId = me?.activeBranchId;
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(
    params.get('buyurtma'),
  );
  const highlight = new Set(
    (params.get('tayyor') ?? '').split(',').filter(Boolean),
  );
  const [assigning, setAssigning] = useState<Order | null>(null);
  const [tableOrders, setTableOrders] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Opened from a notification while the page was already open.
  useEffect(() => {
    const id = params.get('buyurtma');
    if (id) setSelected(id);
  }, [params]);
  // Opened from an alert: /ofitsiant?stol-belgilash=<orderId> asks for a table.
  const alertOrderId = params.get('stol-belgilash');
  const alertOrder = useQuery({
    queryKey: ['orders', 'one', alertOrderId],
    queryFn: () => api<Order>(`/orders/${alertOrderId}`),
    enabled: !!alertOrderId,
  });
  useEffect(() => {
    if (alertOrder.data && !alertOrder.data.table)
      setAssigning(alertOrder.data);
  }, [alertOrder.data]);
  const floor = useQuery({
    queryKey: ['floor', branchId],
    queryFn: () =>
      api<Floor>(`/floor${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: !!branchId,
  });
  const orders = useQuery({
    queryKey: ['orders', 'active-tables', branchId],
    queryFn: () =>
      api<{ orders: Order[] }>(
        `/orders?scope=active${branchId ? `&branchId=${branchId}` : ''}`,
      ).then((data) => data.orders),
    enabled: !!branchId,
    refetchInterval: 15_000,
  });
  if (floor.isPending) return <LoadingState />;
  if (floor.error)
    return (
      <ErrorState error={floor.error} onRetry={() => void floor.refetch()} />
    );
  const all = orders.data ?? [];
  const tableOf = (order: Order) => order.table?.id ?? null;
  const atTable = (tableId: string) =>
    all.filter((order) => tableOf(order) === tableId);
  const waiting = all.filter(
    (order) => order.type === 'DINE_IN' && !order.table,
  );
  const canAssign =
    ordering.tableAssign &&
    (can(me, 'orders.edit') ||
      can(me, 'orders.create') ||
      can(me, 'payments.accept'));
  // Waiters take orders on the order screen (/kassa) with their own role's
  // orders.create; taking payment there still needs payments.accept (server-checked).
  const canOrder = can(me, 'pos.access') || can(me, 'orders.create');
  const closeDetail = () => {
    setSelected(null);
    if (params.has('buyurtma') || params.has('tayyor')) {
      params.delete('buyurtma');
      params.delete('tayyor');
      setParams(params, { replace: true });
    }
  };

  return (
    <div className="stack waiter-page">
      <PageHeader title={t.waiter.title} />
      <div className="orders-toolbar">
        {canOrder && ordering.types.TAKEAWAY && (
          <Button size="lg" onClick={() => navigate('/kassa')}>
            {t.waiter.takeaway}
          </Button>
        )}
        <span className="spacer" />
        {view.canChange && (
          <DisplayModeSwitch mode={view.mode} onChange={view.change} />
        )}
      </div>

      <ReadySection highlight={highlight} />

      {floor.data.rooms.length === 0 ? (
        <EmptyState />
      ) : (
        floor.data.rooms.map((room) => (
          <section key={room.id} className="stack">
            <h2 className="section-title">{room.name}</h2>
            <div className="table-grid">
              {room.tables.map((table) => {
                const here = atTable(table.id);
                const ready = here.some(hasReady);
                const state = ready ? 'ready' : here.length ? 'busy' : 'free';
                return (
                  <button
                    key={table.id}
                    className={`table-tile table-${state} ${here.length ? 'busy' : ''}`}
                    onClick={() =>
                      here.length === 1
                        ? setSelected(here[0]!.id)
                        : here.length
                          ? setTableOrders({ id: table.id, name: table.name })
                          : canOrder
                            ? navigate(`/kassa?stol=${table.id}`)
                            : undefined
                    }
                  >
                    <strong>{table.name}</strong>
                    <span className="table-state">
                      {state === 'ready'
                        ? `✅ ${t.waiter.hasReady}`
                        : state === 'busy'
                          ? t.waiter.open
                          : t.waiter.free}
                    </span>
                    {here.length > 1 && (
                      <small>
                        {t.waiter.orders.replace(
                          '{count}',
                          String(here.length),
                        )}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))
      )}

      {waiting.length > 0 && (
        <section className="guest-waiting" aria-live="polite">
          <h2 className="section-title">
            {t.ordering.waitingGuests} ({waiting.length})
          </h2>
          <OrderBoard
            orders={waiting}
            mode={view.mode === 'detailed' ? 'grid' : view.mode}
            onSelect={(order) => setSelected(order.id)}
            {...(canAssign ? { onAssignTable: setAssigning } : {})}
          />
        </section>
      )}
      {all.length > 0 && (
        <section className="stack">
          <h2 className="section-title">{t.waiter.activeOrders}</h2>
          <OrderBoard
            orders={all}
            mode={view.mode}
            onSelect={(order) => setSelected(order.id)}
            {...(canAssign ? { onAssignTable: setAssigning } : {})}
          />
        </section>
      )}
      {tableOrders && (
        <Dialog
          open
          wide
          title={tableOrders.name}
          onClose={() => setTableOrders(null)}
        >
          <div className="stack">
            <OrderBoard
              orders={atTable(tableOrders.id)}
              mode={view.mode === 'detailed' ? 'grid' : view.mode}
              onSelect={(order) => {
                setTableOrders(null);
                setSelected(order.id);
              }}
            />
            {canOrder && (
              <Button
                variant="primary"
                onClick={() => navigate(`/kassa?stol=${tableOrders.id}`)}
              >
                + {t.pos.addOrder}
              </Button>
            )}
          </div>
        </Dialog>
      )}
      {selected && (
        <OrderDetail
          orderId={selected}
          onClose={closeDetail}
          highlight={highlight}
        />
      )}
      {assigning && (
        <TableAssignDialog
          order={assigning}
          onClose={() => setAssigning(null)}
        />
      )}
    </div>
  );
}
