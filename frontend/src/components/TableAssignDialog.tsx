import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, EmptyState, FormError, LoadingState } from './ui';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { formatOrderNo } from '../lib/uzbek-number';
import { useMe } from '../auth/session';
import { useFloor } from '../pages/FloorPage';

type ActiveOrder = { id: string; tableId?: string | null; table?: { id: string } | null };

/**
 * Chooses or changes the table of an existing order. The order, its items,
 * payments and history stay as they are; only the table changes, and every
 * cashier, waiter and kitchen screen is updated at once.
 */
export function TableAssignDialog({
  order,
  onClose,
  onDone,
}: {
  order: { id: string; number: number; table: { id: string; name: string } | null };
  onClose: () => void;
  onDone?: () => void;
}) {
  const { data: me } = useMe();
  const branchId = me?.activeBranchId;
  const client = useQueryClient();
  const floor = useFloor(branchId);
  const active = useQuery({
    queryKey: ['orders', 'active-tables', branchId],
    queryFn: () =>
      api<{ orders: ActiveOrder[] }>(
        `/orders?scope=active${branchId ? `&branchId=${branchId}` : ''}`,
      ).then((data) => data.orders),
    enabled: !!branchId,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyTables = new Set(
    (active.data ?? [])
      .filter((item) => item.id !== order.id)
      .map((item) => item.tableId ?? item.table?.id)
      .filter((value): value is string => !!value),
  );

  const choose = async (tableId: string) => {
    if (tableId === order.table?.id) {
      onClose();
      return;
    }
    setBusy(tableId);
    setError(null);
    try {
      await post(`/orders/${order.id}/table`, { tableId });
      await client.invalidateQueries({ queryKey: ['orders'] });
      await client.invalidateQueries({ queryKey: ['floor'] });
      onDone?.();
      onClose();
    } catch (caught) {
      setError(caught);
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      wide
      title={`${order.table ? t.ordering.changeTable : t.ordering.assignTable} · ${formatOrderNo(order.number)}`}
      onClose={onClose}
    >
      <div className="stack">
        {floor.isPending ? (
          <LoadingState />
        ) : (floor.data?.rooms ?? []).length === 0 ? (
          <EmptyState />
        ) : (
          floor.data!.rooms.map((room) => (
            <section key={room.id} className="stack compact">
              <h3 className="section-title">{room.name}</h3>
              <div className="table-grid">
                {room.tables.map((table) => (
                  <button
                    key={table.id}
                    className={`table-tile ${busyTables.has(table.id) ? 'busy' : ''} ${
                      table.id === order.table?.id ? 'selected' : ''
                    }`}
                    disabled={busy !== null}
                    aria-pressed={table.id === order.table?.id}
                    onClick={() => void choose(table.id)}
                  >
                    <strong>{table.name}</strong>
                    <span>
                      {busyTables.has(table.id) ? t.waiter.busy : t.waiter.free}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
