import type { Request } from 'express';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';

export type AuditEntry = {
  tenantId?: string | null;
  branchId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  // Never include secrets, hashes, tokens, PINs or full card data.
  data?: Prisma.InputJsonValue;
};

export function requestMeta(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    requestId: (req.res?.locals.requestId as string | undefined) ?? null,
  };
}

/** Writes inside the caller's transaction so the audit row commits with the change. */
export async function audit(
  db: Db | Tx,
  req: Request | null,
  entry: AuditEntry,
) {
  await db.auditLog.create({
    data: {
      tenantId: entry.tenantId ?? null,
      branchId: entry.branchId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(req ? requestMeta(req) : {}),
    },
  });
}
