import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { can, useMe } from '../auth/session';
import { DisplayModeSwitch, OrderBoard } from '../components/OrderBoard';
import { TableAssignDialog } from '../components/TableAssignDialog';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
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

/**
 * Waiter panel: tables, guests still waiting for a table and the active orders.
 * Orders can be edited here (items, notes, table, discounts within the limits the
 * restaurant allows) and new orders are taken on the POS screen.
 */
export function WaiterPage() {
  const { data: me } = useMe();
  const ordering = useOrdering();
  const navigate = useNavigate();
  const view = useOrderDisplayMode();
  const branchId = me?.activeBranchId;
  const [selected, setSelected] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Order | null>(null);
  const [tableOrders, setTableOrders] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Opened from an alert: /ofitsiant?stol-belgilash=<orderId> asks for a table.
  const alertOrderId = new URLSearchParams(window.location.search).get(
    'stol-belgilash',
  );
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
  const countAt = (tableId: string) =>
    all.filter((order) => tableOf(order) === tableId).length;
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

  return (
    <div className="stack">
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
      {floor.data.rooms.length === 0 ? (
        <EmptyState />
      ) : (
        floor.data.rooms.map((room) => (
          <section key={room.id} className="stack">
            <h2 className="section-title">{room.name}</h2>
            <div className="table-grid">
              {room.tables.map((table) => {
                const count = countAt(table.id);
                return (
                  <button
                    key={table.id}
                    className={`table-tile ${count ? 'busy' : ''}`}
                    onClick={() =>
                      count
                        ? setTableOrders({ id: table.id, name: table.name })
                        : canOrder
                          ? navigate(`/kassa?stol=${table.id}`)
                          : undefined
                    }
                  >
                    <strong>{table.name}</strong>
                    <span>
                      {count
                        ? t.waiter.orders.replace('{count}', String(count))
                        : t.waiter.free}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))
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
              orders={all.filter((order) => tableOf(order) === tableOrders.id)}
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
        <OrderDetail orderId={selected} onClose={() => setSelected(null)} />
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
