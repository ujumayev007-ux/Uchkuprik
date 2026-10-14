import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useMe } from '../auth/session';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../components/ui';
import { t } from '../i18n';
import { api } from '../lib/api';
import type { OrderStatus } from '../lib/orders';
import { PaymentBadge, StatusBadge } from './OrdersPage';

type Floor = {
  rooms: {
    id: string;
    name: string;
    tables: { id: string; name: string; seats: number }[];
  }[];
};
type ActiveOrder = {
  id: string;
  number: number;
  status: OrderStatus;
  total: number;
  due: number;
  tableId: string | null;
  table?: { id: string; name: string } | null;
};

/** Waiter panel: tap a table to take its order on the POS screen. */
export function WaiterPage() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const branchId = me?.activeBranchId;
  const floor = useQuery({
    queryKey: ['floor', branchId],
    queryFn: () =>
      api<Floor>(`/floor${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: !!branchId,
  });
  const orders = useQuery({
    queryKey: ['orders', 'active-tables', branchId],
    queryFn: () =>
      api<{ orders: ActiveOrder[] }>(
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
  const busy = (tableId: string) =>
    (orders.data ?? []).filter(
      (order) => (order.tableId ?? order.table?.id) === tableId,
    ).length;
  return (
    <div className="stack">
      <PageHeader title={t.waiter.title} />
      <div>
        <button
          className="btn btn-secondary btn-lg"
          onClick={() => navigate('/kassa')}
        >
          {t.waiter.takeaway}
        </button>
      </div>
      {(orders.data ?? []).length > 0 && (
        <section className="stack">
          <h2 className="section-title">{t.waiter.activeOrders}</h2>
          <div className="table-grid">
            {(orders.data ?? []).map((order) => (
              <button
                key={order.id}
                className="table-tile busy"
                onClick={() =>
                  navigate(
                    order.tableId
                      ? `/kassa?stol=${order.tableId}`
                      : '/buyurtmalar',
                  )
                }
              >
                <strong>№{order.number}</strong>
                <span>{order.table?.name ?? '—'}</span>
                <StatusBadge status={order.status} />
                <PaymentBadge order={order} />
              </button>
            ))}
          </div>
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
                const count = busy(table.id);
                return (
                  <button
                    key={table.id}
                    className={`table-tile ${count ? 'busy' : ''}`}
                    onClick={() => navigate(`/kassa?stol=${table.id}`)}
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
    </div>
  );
}
