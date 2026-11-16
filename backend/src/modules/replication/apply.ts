import type { Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import { syncStockAlert } from '../inventory/alert-sync.js';
import { quoteIdent, replicatedTables, type TableInfo } from './tables.js';

/** One captured change, as it travels between servers. */
export type Change = {
  seq: number;
  tbl: string;
  pk: Record<string, unknown>;
  op: 'I' | 'U' | 'D' | 'S';
  row: Record<string, unknown> | null;
  delta: Record<string, number> | null;
  changedAt: string;
  origin: string;
};

export type ApplyOutcome = 'applied' | 'stale' | 'parked' | 'conflict';

const MAX_PARK_ATTEMPTS = 50;

/** Marks this transaction as "applying the other side's changes": nothing is captured. */
export async function startApplying(tx: Tx) {
  await tx.$executeRaw`SELECT set_config('ff.applying', 'on', true)`;
}

const pkText = (table: TableInfo, pk: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      [...table.pk].sort().map((column) => [column, pk[column] ?? null]),
    ),
  );

/** Stable text form of a key, identical to the trigger's `jsonb::text`. */
async function keyText(tx: Tx, table: TableInfo, pk: Record<string, unknown>) {
  const rows = await tx.$queryRaw<{ key: string }[]>`
    SELECT (${pkText(table, pk)}::jsonb)::text AS key`;
  return rows[0]!.key;
}

/** Later change wins; the same moment is decided by the origin name (both sides agree). */
const newer = (
  a: { changedAt: Date; origin: string },
  b: { changedAt: Date; origin: string },
) =>
  a.changedAt.getTime() !== b.changedAt.getTime()
    ? a.changedAt.getTime() > b.changedAt.getTime()
    : a.origin > b.origin;

/** Key match; $1 is the key JSON, read with each column's own type. */
function whereKey(table: TableInfo) {
  return table.pk
    .map(
      (column) =>
        `t.${quoteIdent(column)} = (($1::jsonb)->>'${column}')::${table.columns.get(column)}`,
    )
    .join(' AND ');
}

/**
 * Applies one change of `tenantId` inside the caller's transaction. A failing change
 * is undone by its own savepoint: a missing parent parks it (retried later), any other
 * error (e.g. the same unique name made on both sides) records a conflict.
 */
export async function applyChange(
  tx: Tx,
  tenantId: string,
  change: Change,
): Promise<ApplyOutcome> {
  const tables = await replicatedTables(tx);
  const table = tables.get(change.tbl);
  if (!table) return conflict(tx, tenantId, change, 'Jadval sinxronlanmaydi');
  // Restaurant isolation: a change may only touch rows of its own tenant.
  const owner =
    table.name === 'tenants'
      ? (change.row?.id ?? change.pk.id)
      : change.op === 'D'
        ? null
        : change.row?.tenantId;
  if (owner !== null && owner !== tenantId)
    return conflict(tx, tenantId, change, 'Boshqa restoran ma’lumoti');
  if (change.op !== 'D' && !change.row)
    return conflict(tx, tenantId, change, 'Bo‘sh qator');

  await tx.$executeRawUnsafe('SAVEPOINT ff_change');
  try {
    const outcome = await applyInner(tx, tenantId, table, change);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT ff_change');
    return outcome;
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT ff_change');
    const code = pgCode(error);
    if (code === '23503') {
      await tx.replicationParked.create({
        data: {
          tenantId,
          origin: change.origin,
          change: change as unknown as Prisma.InputJsonValue,
        },
      });
      return 'parked';
    }
    return conflict(
      tx,
      tenantId,
      change,
      String((error as Error).message).slice(0, 500),
    );
  }
}

function pgCode(error: unknown): string | undefined {
  const text = String(
    (error as { meta?: { code?: string } })?.meta?.code ??
      (error as Error)?.message ??
      '',
  );
  const match = /\b(23\d{3})\b/.exec(text);
  return match?.[1];
}

async function conflict(
  tx: Tx,
  tenantId: string,
  change: Change,
  error: string,
): Promise<ApplyOutcome> {
  await tx.replicationConflict.create({
    data: {
      tenantId,
      origin: change.origin,
      tbl: change.tbl,
      pk: change.pk as Prisma.InputJsonValue,
      op: change.op,
      row: (change.row ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      error,
    },
  });
  return 'conflict';
}

async function applyInner(
  tx: Tx,
  tenantId: string,
  table: TableInfo,
  change: Change,
): Promise<ApplyOutcome> {
  const name = quoteIdent(table.name);
  const key = await keyText(tx, table, change.pk);
  const incoming = {
    changedAt: new Date(change.changedAt),
    origin: change.origin,
  };
  const known = await tx.replicationRow.findUnique({
    where: { tbl_pk: { tbl: table.name, pk: key } },
  });
  const wins = !known || newer(incoming, known);
  const tenantGuard =
    table.name === 'tenants'
      ? `t."id" = '${tenantId}'::uuid`
      : `t."tenantId" = '${tenantId}'::uuid`;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('Bad tenant');
  const keyJson = JSON.stringify(change.pk);

  // Counter changes always count, whichever side last changed the other columns.
  const addDelta = async () => {
    const entries = Object.entries(change.delta ?? {}).filter(
      ([column, value]) =>
        table.additive.includes(column) &&
        Number.isFinite(Number(value)) &&
        Number(value) !== 0,
    );
    if (entries.length === 0) return;
    const sets = entries
      .map(
        ([column, value]) =>
          `${quoteIdent(column)} = t.${quoteIdent(column)} + ${Number(value)}::numeric`,
      )
      .join(', ');
    await tx.$executeRawUnsafe(
      `UPDATE ${name} t SET ${sets} WHERE ${whereKey(table)} AND ${tenantGuard}`,
      keyJson,
    );
  };

  if (change.op === 'D') {
    if (!wins) return 'stale';
    await tx.$executeRawUnsafe(
      `DELETE FROM ${name} t WHERE ${whereKey(table)} AND ${tenantGuard}`,
      keyJson,
    );
    await remember(tx, table.name, key, incoming);
    return 'applied';
  }

  // Privileges that only the central server's own operators may hold are never taken
  // from the wire: a replicated restaurant is a business, its staff are not platform admins.
  const row: Record<string, unknown> = { ...change.row! };
  if (table.name === 'tenants') row.kind = 'BUSINESS';
  if (table.name === 'users' && 'isPlatformAdmin' in row)
    row.isPlatformAdmin = false;
  // Only real columns of this table are written (no column names from the wire).
  const columns = Object.keys(row).filter(
    (column) =>
      table.columns.has(column) &&
      !table.excluded.includes(column) &&
      !columnIsLocalSequence(table, column),
  );
  const list = columns.map(quoteIdent).join(', ');
  const select = columns.map((c) => `r.${quoteIdent(c)}`).join(', ');
  const conflictTarget = table.pk.map(quoteIdent).join(', ');
  const rowJson = JSON.stringify(row);

  if (change.op === 'S') {
    // First full copy: fills what is missing, never overwrites or double counts.
    const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO ${name} (${list})
       SELECT ${select} FROM jsonb_populate_record(NULL::${name}, $1::jsonb) r
       ON CONFLICT (${conflictTarget}) DO NOTHING`,
      rowJson,
    );
    if (inserted > 0 && !known) await remember(tx, table.name, key, incoming);
    await afterApply(tx, table, row);
    return 'applied';
  }

  if (!wins) {
    // Other columns are newer here; counters still move.
    if (change.op === 'U') await addDelta();
    await afterApply(tx, table, row);
    return 'stale';
  }

  const updatable = columns.filter((column) => !table.pk.includes(column));
  const updates = updatable.map((column) => {
    const q = quoteIdent(column);
    if (table.additive.includes(column))
      return change.op === 'I'
        ? `${q} = t.${q} + EXCLUDED.${q}`
        : `${q} = t.${q} + ${finite(change.delta?.[column])}::numeric`;
    return `${q} = EXCLUDED.${q}`;
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO ${name} AS t (${list})
     SELECT ${select} FROM jsonb_populate_record(NULL::${name}, $1::jsonb) r
     ON CONFLICT (${conflictTarget}) DO ${
       updates.length
         ? `UPDATE SET ${updates.join(', ')} WHERE ${tenantGuard}`
         : 'NOTHING'
     }`,
    rowJson,
  );
  await remember(tx, table.name, key, incoming);
  await afterApply(tx, table, row);
  return 'applied';
}

const finite = (value: unknown) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

// The per-server sequence id of uid tables is assigned locally.
const columnIsLocalSequence = (table: TableInfo, column: string) =>
  table.pk[0] === 'uid' && column === 'id';

async function remember(
  tx: Tx,
  tbl: string,
  pk: string,
  at: { changedAt: Date; origin: string },
) {
  await tx.replicationRow.upsert({
    where: { tbl_pk: { tbl, pk } },
    create: { tbl, pk, changedAt: at.changedAt, origin: at.origin },
    update: { changedAt: at.changedAt, origin: at.origin },
  });
}

/** Derived state of this server follows the applied change (stock alerts). */
async function afterApply(
  tx: Tx,
  table: TableInfo,
  row: Record<string, unknown>,
) {
  if (table.name !== 'stock_balances') return;
  const current = await tx.stockBalance.findUnique({
    where: {
      warehouseId_stockItemId: {
        warehouseId: String(row.warehouseId),
        stockItemId: String(row.stockItemId),
      },
    },
  });
  if (current)
    await syncStockAlert(
      tx,
      {
        tenantId: current.tenantId,
        warehouseId: current.warehouseId,
        stockItemId: current.stockItemId,
      },
      new Prisma.Decimal(current.quantity),
    );
}

/** Parked changes (waiting for a parent row) are tried again, oldest first. */
export async function retryParked(tx: Tx, tenantId: string) {
  const parked = await tx.replicationParked.findMany({
    where: { tenantId },
    orderBy: { id: 'asc' },
    take: 500,
  });
  let applied = 0;
  for (const item of parked) {
    await tx.replicationParked.delete({ where: { id: item.id } });
    const change = item.change as unknown as Change;
    const outcome = await applyChange(tx, tenantId, change);
    if (outcome === 'parked') {
      // applyChange parked it again as a new row: keep the attempt count.
      const again = await tx.replicationParked.findFirst({
        where: { tenantId },
        orderBy: { id: 'desc' },
      });
      if (again) {
        if (item.attempts + 1 >= MAX_PARK_ATTEMPTS) {
          await tx.replicationParked.delete({ where: { id: again.id } });
          await conflict(tx, tenantId, change, 'Bog‘liq yozuv topilmadi');
        } else
          await tx.replicationParked.update({
            where: { id: again.id },
            data: { attempts: item.attempts + 1, createdAt: item.createdAt },
          });
      }
    } else applied += 1;
  }
  return applied;
}
