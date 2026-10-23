import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  PageHeader,
  SelectField,
  TextField,
  useConfirm,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, del, errorMessage, patch, post } from '../lib/api';
import { TableQrDialog } from '../components/TableQrDialog';

export type Table = {
  id: string;
  name: string;
  seats: number;
  sortOrder: number;
  isActive: boolean;
  qrToken?: string;
};
export type Room = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  tables: Table[];
};

export function useFloor(branchId: string | null | undefined) {
  return useQuery({
    queryKey: ['floor', branchId],
    queryFn: () =>
      api<{ branchId: string; rooms: Room[] }>(`/floor?branchId=${branchId}`),
    enabled: !!branchId,
  });
}

type Editing =
  | { kind: 'room'; room: Room | null }
  | { kind: 'table'; table: Table | null; roomId: string };

function RoomForm({
  branchId,
  room,
  onDone,
}: {
  branchId: string;
  room: Room | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(room?.name ?? '');
  const [sortOrder, setSortOrder] = useState(room?.sortOrder ?? 0);
  const [isActive, setActive] = useState(room?.isActive ?? true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (room)
            await patch(`/rooms/${room.id}`, { name, sortOrder, isActive });
          else await post('/rooms', { branchId, name, sortOrder, isActive });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={t.floor.roomName}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoFocus
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

function TableForm({
  rooms,
  table,
  roomId,
  onDone,
}: {
  rooms: Room[];
  table: Table | null;
  roomId: string;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    roomId,
    name: table?.name ?? '',
    seats: table?.seats ?? 4,
    sortOrder: table?.sortOrder ?? 0,
    isActive: table?.isActive ?? true,
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (table) await patch(`/tables/${table.id}`, form);
          else await post('/tables', form);
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <SelectField
        label={t.floor.room}
        value={form.roomId}
        onChange={(e) => setForm({ ...form, roomId: e.target.value })}
      >
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </SelectField>
      <div className="form-grid">
        <TextField
          label={t.floor.tableName}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
          autoFocus
        />
        <TextField
          label={t.floor.seats}
          type="number"
          min={1}
          max={100}
          value={form.seats}
          onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })}
          required
        />
        <TextField
          label={t.floor.sortOrder}
          type="number"
          min={0}
          value={form.sortOrder}
          onChange={(e) =>
            setForm({ ...form, sortOrder: Number(e.target.value) })
          }
        />
      </div>
      <Checkbox
        label={t.common.active}
        checked={form.isActive}
        onChange={(isActive) => setForm({ ...form, isActive })}
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

export function FloorPage() {
  const { data: me } = useMe();
  const floor = useFloor(me?.activeBranchId);
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element: confirmElement } = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [qrFor, setQrFor] = useState<Table | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const manage = can(me, 'tables.manage');
  const refresh = () => client.invalidateQueries({ queryKey: ['floor'] });
  const rooms = floor.data?.rooms ?? [];

  const allVisibleTables = rooms.flatMap((r) =>
    r.tables.filter((t) => showInactive || t.isActive),
  );
  const allSelected =
    allVisibleTables.length > 0 &&
    allVisibleTables.every((t) => selectedIds.includes(t.id));

  async function handleDeleteTable(table: Table) {
    if (!(await confirm(t.floor.deleteTableConfirm))) return;
    try {
      await del(`/tables/${table.id}`);
      toast(t.floor.tableDeleted);
      setSelectedIds((prev) => prev.filter((id) => id !== table.id));
      await refresh();
    } catch (caught) {
      const msg = errorMessage(caught);
      if (
        msg.includes('TABLE_HAS_ACTIVE_ORDERS') ||
        msg.includes('tableHasOrder')
      ) {
        toast(t.floor.hasActiveOrders, 'error');
      } else {
        toast(msg, 'error');
      }
    }
  }

  async function handleRestoreTable(table: Table) {
    if (!(await confirm(t.floor.restoreTableConfirm))) return;
    try {
      await post(`/tables/${table.id}/restore`);
      toast(t.floor.tableRestored);
      setSelectedIds((prev) => prev.filter((id) => id !== table.id));
      await refresh();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.length === 0) return;
    const msg = t.floor.deleteSelectedConfirm.replace(
      '{count}',
      String(selectedIds.length),
    );
    if (!(await confirm(msg))) return;
    try {
      await post('/tables/batch-delete', { ids: selectedIds });
      toast(
        t.floor.batchDeleted.replace('{count}', String(selectedIds.length)),
      );
      setSelectedIds([]);
      await refresh();
    } catch (caught) {
      const msgErr = errorMessage(caught);
      if (
        msgErr.includes('TABLE_HAS_ACTIVE_ORDERS') ||
        msgErr.includes('tableHasOrder')
      ) {
        toast(t.floor.hasActiveOrders, 'error');
      } else {
        toast(msgErr, 'error');
      }
    }
  }

  async function handleBatchRestore() {
    if (selectedIds.length === 0) return;
    const msg = t.floor.restoreSelectedConfirm.replace(
      '{count}',
      String(selectedIds.length),
    );
    if (!(await confirm(msg))) return;
    try {
      await post('/tables/batch-restore', { ids: selectedIds });
      toast(
        t.floor.batchRestored.replace('{count}', String(selectedIds.length)),
      );
      setSelectedIds([]);
      await refresh();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title={t.floor.title}
        subtitle={t.floor.subtitle}
        actions={
          manage && (
            <>
              <Button onClick={() => setEditing({ kind: 'room', room: null })}>
                + {t.floor.addRoom}
              </Button>
              {rooms.length > 0 && (
                <Button
                  variant="primary"
                  onClick={() =>
                    setEditing({
                      kind: 'table',
                      table: null,
                      roomId: rooms[0]!.id,
                    })
                  }
                >
                  + {t.floor.addTable}
                </Button>
              )}
            </>
          )
        }
      />
      {manage && rooms.length > 0 && (
        <div
          className="card"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 16px',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Checkbox
              label={t.floor.showInactive}
              checked={showInactive}
              onChange={setShowInactive}
            />
          </div>
          {allVisibleTables.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (allSelected) {
                    setSelectedIds([]);
                  } else {
                    setSelectedIds(allVisibleTables.map((t) => t.id));
                  }
                }}
              >
                {allSelected ? t.floor.deselectAll : t.floor.selectAll}
              </Button>
              {selectedIds.length > 0 && (
                <>
                  <span className="muted" style={{ fontSize: 13 }}>
                    ({selectedIds.length})
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={handleBatchDelete}
                  >
                    {t.floor.deleteSelected}
                  </Button>
                  {showInactive && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleBatchRestore}
                    >
                      {t.floor.restoreSelected}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!me?.activeBranchId ? (
        <EmptyState title={t.nav.selectBranch} />
      ) : floor.isPending ? (
        <LoadingState />
      ) : floor.error ? (
        <ErrorState error={floor.error} onRetry={() => void floor.refetch()} />
      ) : rooms.length === 0 ? (
        <EmptyState title={t.floor.noRooms} />
      ) : (
        <div className="card-list">
          {rooms.map((room) => {
            const visibleTables = room.tables.filter(
              (table) => showInactive || table.isActive,
            );
            return (
              <section key={room.id} className="card">
                <header className="room-header">
                  <h2 className="room-title">
                    {room.name}{' '}
                    {!room.isActive && <Badge>{t.common.inactive}</Badge>}
                  </h2>
                  {manage && (
                    <div className="form-actions">
                      <Button
                        size="sm"
                        onClick={() =>
                          setEditing({
                            kind: 'table',
                            table: null,
                            roomId: room.id,
                          })
                        }
                      >
                        + {t.floor.addTable}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ kind: 'room', room })}
                      >
                        {t.common.edit}
                      </Button>
                    </div>
                  )}
                </header>
                <div className="table-grid">
                  {visibleTables.map((table) => (
                    <div
                      key={table.id}
                      className={`table-tile ${table.isActive ? '' : 'is-inactive'}`}
                      style={{ position: 'relative' }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {manage && (
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(table.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedIds((prev) => [...prev, table.id]);
                                } else {
                                  setSelectedIds((prev) =>
                                    prev.filter((id) => id !== table.id),
                                  );
                                }
                              }}
                              aria-label={table.name}
                            />
                          )}
                          <strong>{table.name}</strong>
                        </div>
                        {!table.isActive && (
                          <Badge tone="warning">{t.common.inactive}</Badge>
                        )}
                      </div>
                      <span className="muted">
                        {table.seats} {t.floor.seatsShort}
                      </span>
                      {manage && (
                        <div className="tile-actions">
                          {table.isActive ? (
                            <>
                              <button
                                type="button"
                                className="text-link"
                                onClick={() =>
                                  setEditing({
                                    kind: 'table',
                                    table,
                                    roomId: room.id,
                                  })
                                }
                              >
                                {t.common.edit}
                              </button>
                              {table.qrToken && (
                                <button
                                  type="button"
                                  className="text-link"
                                  onClick={() => setQrFor(table)}
                                >
                                  {t.online.qr}
                                </button>
                              )}
                              <button
                                type="button"
                                className="text-link"
                                onClick={async () => {
                                  if (!(await confirm(t.floor.rotateConfirm))) {
                                    return;
                                  }
                                  try {
                                    await post(`/tables/${table.id}/rotate-qr`);
                                    toast(t.common.saved);
                                    await refresh();
                                  } catch (caught) {
                                    toast(errorMessage(caught), 'error');
                                  }
                                }}
                              >
                                {t.floor.rotateQr}
                              </button>
                              <button
                                type="button"
                                className="text-link"
                                style={{
                                  color: 'var(--color-danger, #ef4444)',
                                }}
                                onClick={() => handleDeleteTable(table)}
                              >
                                {t.common.delete}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="text-link"
                              style={{
                                color: 'var(--color-primary, #10b981)',
                                fontWeight: 600,
                              }}
                              onClick={() => handleRestoreTable(table)}
                            >
                              {t.floor.restoreTable}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Dialog
        open={editing !== null}
        title={
          editing?.kind === 'room'
            ? editing.room
              ? t.common.edit
              : t.floor.addRoom
            : editing?.table
              ? t.common.edit
              : t.floor.addTable
        }
        onClose={() => setEditing(null)}
      >
        {editing &&
          me?.activeBranchId &&
          (editing.kind === 'room' ? (
            <RoomForm
              branchId={me.activeBranchId}
              room={editing.room}
              onDone={async () => {
                setEditing(null);
                toast(t.common.saved);
                await refresh();
              }}
            />
          ) : (
            <TableForm
              rooms={rooms}
              table={editing.table}
              roomId={editing.roomId}
              onDone={async () => {
                setEditing(null);
                toast(t.common.saved);
                await refresh();
              }}
            />
          ))}
      </Dialog>
      {qrFor?.qrToken && (
        <TableQrDialog
          tableName={qrFor.name}
          token={qrFor.qrToken}
          onClose={() => setQrFor(null)}
        />
      )}
      {confirmElement}
    </>
  );
}
