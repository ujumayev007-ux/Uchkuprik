import { randomUUID } from 'node:crypto';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';

// Durable outbox of operations that must reach the centre. A row is written (in the
// same transaction as the business change where possible) before anything is sent
// and is only marked DONE after the server acknowledged its operation id, so an
// outage or a crash can neither lose nor duplicate an operation.

export type OutboxItem = {
  opId: string;
  type: string;
  key: string | null;
  data: Record<string, unknown>;
};

export type SendResult = { opId: string; status: string; message?: string };

const BATCH = 50;
const MAX_BACKOFF_MS = 15 * 60_000;

export async function enqueueOperation(
  db: Db | Tx,
  input: {
    type: string;
    data: Record<string, unknown>;
    key?: string;
    opId?: string;
  },
): Promise<string> {
  const opId = input.opId ?? randomUUID();
  await db.syncOperation.createMany({
    data: [
      {
        opId,
        type: input.type,
        payload: {
          key: input.key ?? null,
          data: input.data,
        } as Prisma.InputJsonValue,
      },
    ],
    // The same operation id is stored once, however often it is produced.
    skipDuplicates: true,
  });
  return opId;
}

export async function outboxSummary(db: Db | Tx) {
  const [pending, conflicts, failed, oldest] = await Promise.all([
    db.syncOperation.count({ where: { status: 'PENDING' } }),
    db.syncOperation.count({ where: { status: 'CONFLICT' } }),
    db.syncOperation.count({ where: { status: 'FAILED' } }),
    db.syncOperation.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, lastError: true },
    }),
  ]);
  return {
    pending,
    conflicts,
    failed,
    oldestPendingAt: oldest?.createdAt ?? null,
    lastError: oldest?.lastError ?? null,
  };
}

export async function listOutbox(db: Db, limit = 100) {
  return db.syncOperation.findMany({
    where: { status: { not: 'DONE' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** Puts a failed or conflicting operation back in the queue (explicit decision). */
export async function retryOperation(db: Db, id: string) {
  const result = await db.syncOperation.updateMany({
    where: { id, status: { in: ['FAILED', 'CONFLICT'] } },
    data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null },
  });
  return result.count > 0;
}

export async function flushOutbox(
  services: Services,
  send: (items: OutboxItem[]) => Promise<SendResult[]>,
): Promise<{ sent: number }> {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const rows = await db.syncOperation.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });
  if (rows.length === 0) return { sent: 0 };
  const items: OutboxItem[] = rows.map((row) => {
    const payload = row.payload as {
      key?: string | null;
      data?: Record<string, unknown>;
    };
    return {
      opId: row.opId,
      type: row.type,
      key: payload.key ?? null,
      data: payload.data ?? {},
    };
  });
  let results: SendResult[];
  try {
    results = await send(items);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const permanent = status === 400;
    for (const row of rows) {
      const attempts = row.attempts + 1;
      await db.syncOperation.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: status ? `HTTP_${status}` : 'NETWORK',
          status: permanent ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(
            now.getTime() +
              Math.min(30_000 * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS),
          ),
        },
      });
    }
    return { sent: 0 };
  }
  let sent = 0;
  for (const result of results) {
    const row = rows.find((item) => item.opId === result.opId);
    if (!row) continue;
    if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
      sent++;
      await db.syncOperation.update({
        where: { id: row.id },
        data: {
          status: 'DONE',
          doneAt: now,
          attempts: row.attempts + 1,
          lastError: null,
          result: { status: result.status } as Prisma.InputJsonValue,
        },
      });
    } else if (result.status === 'CONFLICT') {
      await db.syncOperation.update({
        where: { id: row.id },
        data: {
          status: 'CONFLICT',
          attempts: row.attempts + 1,
          lastError: result.message ?? 'CONFLICT',
          result: { status: 'CONFLICT' } as Prisma.InputJsonValue,
        },
      });
    }
  }
  return { sent };
}

/** One summary per branch and finished business day (key = branch:date). */
export async function scheduleDailySummaries(services: Services) {
  const { db } = services;
  const now = services.now?.() ?? new Date();
  const yesterday = new Date(now.getTime() + 5 * 3_600_000 - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const businessDate = new Date(`${yesterday}T00:00:00.000Z`);
  const branches = await db.branch.findMany({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, code: true },
  });
  for (const branch of branches) {
    const [completed, cancelled] = await Promise.all([
      db.order.aggregate({
        where: {
          tenantId: branch.tenantId,
          branchId: branch.id,
          businessDate,
          status: 'COMPLETED',
        },
        _sum: { total: true },
        _count: true,
      }),
      db.order.count({
        where: {
          tenantId: branch.tenantId,
          branchId: branch.id,
          businessDate,
          status: 'CANCELLED',
        },
      }),
    ]);
    if (completed._count === 0 && cancelled === 0) continue;
    const key = `${branch.code}:${yesterday}`;
    await enqueueOperation(db, {
      type: 'daily_summary',
      key,
      opId: `ds-${branch.code}-${yesterday}`,
      data: {
        branch: branch.code,
        date: yesterday,
        orders: completed._count,
        total: completed._sum.total ?? 0,
        cancelled,
      },
    });
  }
}

/**
 * Display counters of advertisements: one cumulative operation per campaign, day and
 * panel whenever the numbers changed (the centre keeps the larger value, so retries
 * and repeated reports never double count).
 */
export async function scheduleAdStats(services: Services) {
  const { db } = services;
  const rows = await db.$queryRaw<
    {
      campaignId: string;
      day: Date;
      panel: string;
      shown: number;
      closed: number;
    }[]
  >`SELECT "campaignId", "day", "panel", "shown", "closed" FROM "ad_stats"
     WHERE "shown" > "shownSent" OR "closed" > "closedSent" LIMIT 200`;
  for (const row of rows) {
    const day = row.day.toISOString().slice(0, 10);
    await enqueueOperation(db, {
      type: 'ad_stats',
      opId: `as-${row.campaignId.slice(0, 8)}-${day}-${row.panel}-${row.shown}-${row.closed}`,
      data: {
        campaignId: row.campaignId,
        day,
        panel: row.panel,
        shown: row.shown,
        closed: row.closed,
      },
    });
    await db.$executeRaw`UPDATE "ad_stats" SET "shownSent" = ${row.shown}, "closedSent" = ${row.closed}
       WHERE "campaignId" = ${row.campaignId}::uuid AND "day" = ${row.day} AND "panel" = ${row.panel}`;
  }
}
