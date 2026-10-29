import type { Db, Tx } from '../../db.js';
import { AppError, errors } from '../../http/errors.js';
import {
  orderWorkflow,
  readOrderWorkflow,
  sourcesOf,
  workflowConfigSchema,
  zoneOf,
  type ActiveWorkflow,
  type OrderWorkflow,
} from './engine.js';

/**
 * The restaurant server's side of the workflow engine: the configuration activated by
 * the SUPER_OWNER (TenantProfile.workflow) and the snapshot each new order takes.
 */
export async function loadWorkflow(
  db: Db | Tx,
  tenantId: string,
): Promise<ActiveWorkflow | null> {
  const profile = await db.tenantProfile.findUnique({
    where: { tenantId },
    select: { workflow: true, workflowVersion: true },
  });
  if (!profile?.workflow) return null;
  const parsed = workflowConfigSchema.safeParse(profile.workflow);
  return parsed.success
    ? { version: profile.workflowVersion, config: parsed.data }
    : null;
}

/** Stores the configuration sent by the centre (newer versions only). */
export async function storeWorkflow(
  db: Db | Tx,
  tenantId: string,
  incoming: { version: number; config: unknown },
): Promise<boolean> {
  const parsed = workflowConfigSchema.safeParse(incoming.config);
  if (!parsed.success) return false;
  const current = await db.tenantProfile.findUnique({
    where: { tenantId },
    select: { workflowVersion: true },
  });
  if (current && current.workflowVersion >= incoming.version) return false;
  await db.tenantProfile.upsert({
    where: { tenantId },
    create: {
      tenantId,
      workflow: parsed.data,
      workflowVersion: incoming.version,
    },
    update: { workflow: parsed.data, workflowVersion: incoming.version },
  });
  return true;
}

/**
 * The flow a new order follows (null: no workflow for its zone — existing behaviour).
 * Refuses a source the zone does not accept.
 */
export async function snapshotFor(
  tx: Db | Tx,
  input: {
    tenantId: string;
    type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    channel: 'POS' | 'WAITER' | 'QR' | 'WEB' | 'TELEGRAM';
    tableId: string | null;
    // Staff placing it without cashier rights (a waiter).
    waiter: boolean;
  },
): Promise<OrderWorkflow | null> {
  const active = await loadWorkflow(tx, input.tenantId);
  if (!active?.config.enabled) return null;
  const table = input.tableId
    ? await tx.diningTable.findFirst({
        where: { id: input.tableId, tenantId: input.tenantId },
        select: { room: { select: { kind: true } } },
      })
    : null;
  const zone = zoneOf({
    type: input.type,
    channel: input.channel,
    roomKind: table?.room.kind ?? null,
    waiter: input.waiter,
  });
  const flow = orderWorkflow(active, zone);
  if (!flow) return null;
  const sources = sourcesOf(input);
  if (!sources.some((source) => flow.sources.includes(source)))
    throw new AppError(403, 'WORKFLOW_SOURCE', 'workflowSource', { zone });
  return flow;
}

export const orderFlow = (order: { workflow?: unknown }) =>
  readOrderWorkflow(order.workflow);

/** A waiter (no cashier rights) placing an order from a staff screen. */
export const isWaiter = (auth: {
  permissions: Set<string>;
  roleKeys: readonly string[];
}) =>
  auth.roleKeys.includes('waiter') || !auth.permissions.has('payments.accept');

/** A time for the order only where the zone's workflow schedules (orders, banquets). */
export function assertSchedule(
  flow: OrderWorkflow | null,
  scheduledFor: Date | null,
  at: Date,
) {
  if (!scheduledFor) return;
  if (!flow?.scheduling)
    throw new AppError(409, 'WORKFLOW_SCHEDULE', 'workflowSchedule');
  if (
    scheduledFor.getTime() <= at.getTime() ||
    scheduledFor.getTime() > at.getTime() + 366 * 86_400_000
  )
    throw errors.validation([{ path: 'scheduledFor' }]);
}
