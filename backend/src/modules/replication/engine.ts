import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../db.js';
import type { SecretBox } from '../../lib/crypto.js';
import { clearPinKeyCache } from '../../lib/pin.js';
import {
  applyChange,
  retryParked,
  startApplying,
  type Change,
} from './apply.js';
import {
  copyOrder,
  installTriggers,
  quoteIdent,
  replicatedTables,
} from './tables.js';

export const HUB_NODE = 'hub';
// One request carries at most this much change data (JSON characters).
const BATCH_BYTES = 1_500_000;
const BATCH_ROWS = 500;
const TX = { timeout: 120_000, maxWait: 15_000 };

export class ReplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const toChange = (row: {
  seq: bigint;
  tbl: string;
  pk: unknown;
  op: string;
  row: unknown;
  delta: unknown;
  changedAt: Date;
  origin: string;
}): Change => ({
  seq: Number(row.seq),
  tbl: row.tbl,
  pk: row.pk as Change['pk'],
  op: row.op as Change['op'],
  row: (row.row ?? null) as Change['row'],
  delta: (row.delta ?? null) as Change['delta'],
  changedAt: row.changedAt.toISOString(),
  origin: row.origin,
});

/** Changes of `tenantId` after `afterSeq`, cut to one request's size. */
export async function changesAfter(
  db: Db | Tx,
  tenantId: string,
  afterSeq: number,
  exceptOrigin?: string,
) {
  const rows = await db.replicationChange.findMany({
    where: {
      tenantId,
      seq: { gt: BigInt(afterSeq) },
      ...(exceptOrigin ? { origin: { not: exceptOrigin } } : {}),
    },
    orderBy: { seq: 'asc' },
    take: BATCH_ROWS + 1,
  });
  const changes: Change[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, BATCH_ROWS)) {
    const change = toChange(row);
    const size = JSON.stringify(change).length;
    if (changes.length > 0 && bytes + size > BATCH_BYTES) break;
    changes.push(change);
    bytes += size;
  }
  return {
    changes,
    more: changes.length < rows.length,
    lastSeq: changes.length ? changes[changes.length - 1]!.seq : afterSeq,
  };
}

/**
 * Kassa server: takes part in replication with this restaurant. In one transaction
 * the capture triggers are installed, the restaurant key is made and every existing
 * row is queued once as a "snapshot" change (the first full copy). Concurrent writes
 * wait for the trigger installation, so nothing falls between copy and capture.
 */
export async function attachSpoke(
  db: Db,
  secrets: SecretBox,
  tenantId: string,
) {
  const existing = await db.replicationTenant.findUnique({
    where: { tenantId },
  });
  if (existing) return { attached: false, queued: 0 };
  const queued = await db.$transaction(async (tx) => {
    await installTriggers(tx);
    const nodeId = `k-${randomBytes(6).toString('hex')}`;
    await tx.replicationTenant.create({
      data: {
        tenantId,
        role: 'spoke',
        nodeId,
        pinKeyEnc: secrets.encrypt(randomBytes(32).toString('base64')),
      },
    });
    return snapshot(tx, tenantId, nodeId);
  }, TX);
  clearPinKeyCache();
  return { attached: true, queued };
}

/** Queues every row of the tenant as an "S" change, parents before children. */
async function snapshot(tx: Tx, tenantId: string, nodeId: string) {
  const tables = await replicatedTables(tx);
  let queued = 0;
  for (const name of copyOrder(tables)) {
    const table = tables.get(name)!;
    const key = table.pk
      .map((column) => `'${column}', to_jsonb(t)->'${column}'`)
      .join(', ');
    const scope =
      name === 'tenants' ? `t."id" = $1::uuid` : `t."tenantId" = $1::uuid`;
    // Oldest moment: a copy never overrides a real change made on the other side.
    queued += await tx.$executeRawUnsafe(
      `INSERT INTO replication_changes ("tenantId", tbl, pk, op, "row", delta, "changedAt", origin)
       SELECT $1::uuid, $2, jsonb_build_object(${key}), 'S', to_jsonb(t) - $3::text[], NULL,
              to_timestamp(0), $4
         FROM ${quoteIdent(name)} t WHERE ${scope}`,
      tenantId,
      name,
      table.excluded,
      nodeId,
    );
  }
  return queued;
}

/** Applies a batch of the other side's changes (in order) in the caller's transaction. */
export async function applyBatch(tx: Tx, tenantId: string, changes: Change[]) {
  await startApplying(tx);
  const counts = { applied: 0, stale: 0, parked: 0, conflict: 0 };
  for (const change of changes)
    counts[await applyChange(tx, tenantId, change)] += 1;
  if (changes.length) counts.applied += await retryParked(tx, tenantId);
  return counts;
}

export type ReplicatePayload = {
  tenantId: string;
  nodeId: string;
  // First contact: the restaurant key and the business code (shown in errors).
  pinKey?: string;
  changes: Change[];
  since: number;
};

/**
 * Central server: receives a Kassa server's changes for its restaurant and returns the
 * central changes it has not seen. The licence's customer owns the restaurant here;
 * any other customer is refused. Each Kassa change is applied exactly once (the
 * highest applied sequence is stored in the same transaction).
 */
export async function receiveFromSpoke(
  db: Db,
  secrets: SecretBox,
  customerId: string,
  payload: ReplicatePayload,
) {
  const { tenantId, nodeId } = payload;
  let link = await db.replicationTenant.findUnique({ where: { tenantId } });
  if (!link) {
    if (!payload.pinKey)
      throw new ReplicationError('NOT_ATTACHED', 'Restoran markazga ulanmagan');
    const other = await db.replicationTenant.findFirst({
      where: { customerId, NOT: { tenantId } },
    });
    if (other)
      throw new ReplicationError(
        'CUSTOMER_HAS_TENANT',
        'Bu litsenziya boshqa restoranga bog‘langan',
      );
    const clash = await db.tenant.findUnique({ where: { id: tenantId } });
    if (clash)
      throw new ReplicationError('TENANT_EXISTS', 'Restoran markazda bor');
    await db.$transaction(async (tx) => {
      await installTriggers(tx);
      await tx.replicationTenant.create({
        data: {
          tenantId,
          role: 'hub',
          nodeId: HUB_NODE,
          customerId,
          pinKeyEnc: secrets.encrypt(payload.pinKey!),
        },
      });
    }, TX);
    clearPinKeyCache();
    link = await db.replicationTenant.findUniqueOrThrow({
      where: { tenantId },
    });
  }
  if (link.role !== 'hub' || link.customerId !== customerId)
    throw new ReplicationError('FORBIDDEN', 'Bu restoran boshqa mijozniki');
  if (nodeId === HUB_NODE || !/^k-[0-9a-f]{12}$/.test(nodeId))
    throw new ReplicationError('BAD_NODE', 'Noto‘g‘ri server nomi');

  const result = await db.$transaction(async (tx) => {
    const peer = await tx.replicationPeer.upsert({
      where: { origin_tenantId: { origin: nodeId, tenantId } },
      create: { origin: nodeId, tenantId },
      update: {},
    });
    const fresh = payload.changes.filter(
      (change) =>
        change.seq > Number(peer.appliedSeq) && change.origin === nodeId,
    );
    const counts = await applyBatch(tx, tenantId, fresh);
    const ack = Math.max(
      Number(peer.appliedSeq),
      ...payload.changes.map((change) => change.seq),
    );
    await tx.replicationTenant.update({
      where: { tenantId },
      data: { lastSyncAt: new Date(), lastError: null },
    });
    if (ack > Number(peer.appliedSeq))
      await tx.replicationPeer.update({
        where: { origin_tenantId: { origin: nodeId, tenantId } },
        data: { appliedSeq: BigInt(ack) },
      });
    return { ack, counts };
  }, TX);
  const outgoing = await changesAfter(db, tenantId, payload.since, nodeId);
  return {
    ack: result.ack,
    counts: result.counts,
    changes: outgoing.changes,
    next: outgoing.lastSeq,
    more: outgoing.more,
  };
}

/** Kassa server: applies the central server's answer and moves both cursors. */
export async function acceptFromHub(
  db: Db,
  tenantId: string,
  answer: { ack: number; changes: Change[]; next: number },
) {
  return db.$transaction(async (tx) => {
    const link = await tx.replicationTenant.findUniqueOrThrow({
      where: { tenantId },
    });
    const fresh = answer.changes.filter(
      (change) => change.seq > Number(link.pulledSeq),
    );
    const counts = await applyBatch(tx, tenantId, fresh);
    await tx.replicationTenant.update({
      where: { tenantId },
      data: {
        pushedSeq: BigInt(Math.max(Number(link.pushedSeq), answer.ack)),
        pulledSeq: BigInt(Math.max(Number(link.pulledSeq), answer.next)),
        lastSyncAt: new Date(),
        lastError: null,
      },
    });
    return counts;
  }, TX);
}

/** Old change records: the Kassa keeps acknowledged ones 3 days, the centre 60 days. */
export async function pruneChanges(db: Db, now = new Date()) {
  const links = await db.replicationTenant.findMany();
  for (const link of links) {
    const days = link.role === 'hub' ? 60 : 3;
    await db.replicationChange.deleteMany({
      where: {
        tenantId: link.tenantId,
        ...(link.role === 'spoke' ? { seq: { lte: link.pushedSeq } } : {}),
        changedAt: { lt: new Date(now.getTime() - days * 86_400_000) },
      },
    });
  }
}

/** What the Admin sees: queue, last contact, conflicts. */
export async function replicationStatus(db: Db | Tx, tenantId: string) {
  const link = await db.replicationTenant.findUnique({ where: { tenantId } });
  if (!link) return { attached: false as const };
  const [pending, conflicts, parked] = await Promise.all([
    link.role === 'spoke'
      ? db.replicationChange.count({
          where: { tenantId, seq: { gt: link.pushedSeq } },
        })
      : Promise.resolve(0),
    db.replicationConflict.count({ where: { tenantId, resolvedAt: null } }),
    db.replicationParked.count({ where: { tenantId } }),
  ]);
  return {
    attached: true as const,
    role: link.role,
    pending,
    conflicts,
    parked,
    lastSyncAt: link.lastSyncAt,
    lastError: link.lastError,
  };
}

/** Central server start: capture triggers exist for every attached restaurant. */
export async function ensureHubTriggers(db: Db) {
  if ((await db.replicationTenant.count()) === 0) return 0;
  return installTriggers(db);
}
