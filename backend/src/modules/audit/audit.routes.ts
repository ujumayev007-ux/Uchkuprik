import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { parse } from '../../http/errors.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requirePlatformAdmin,
} from '../auth/session.js';

const query = z.object({
  action: z.string().trim().max(60).optional(),
  before: z.coerce.bigint().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRouter(services: Services) {
  const { db } = services;
  const router = Router();

  const list = async (
    tenantId: string | undefined,
    input: z.infer<typeof query>,
  ) => {
    const rows = await db.auditLog.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(input.action ? { action: { startsWith: input.action } } : {}),
        ...(input.before ? { id: { lt: input.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: input.limit,
    });
    const actorIds = [
      ...new Set(
        rows.map((row) => row.actorUserId).filter((id) => id !== null),
      ),
    ];
    const actors = await db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, displayName: true },
    });
    const names = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    return {
      entries: rows.map((row) => ({
        id: row.id.toString(),
        action: row.action,
        outcome: row.outcome,
        entityType: row.entityType,
        entityId: row.entityId,
        branchId: row.branchId,
        actorUserId: row.actorUserId,
        actorName: row.actorUserId
          ? (names.get(row.actorUserId) ?? null)
          : null,
        data: row.data,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      })),
      nextBefore:
        rows.length === input.limit ? rows.at(-1)!.id.toString() : null,
    };
  };

  router.get(
    '/audit-logs',
    requireAuth(),
    requirePermission('audit.view'),
    async (req, res) => {
      res.json(await list(getAuth(res).tenantId, parse(query, req.query)));
    },
  );

  // Platform operators see security events across tenants for incident response.
  router.get(
    '/platform/audit-logs',
    requireAuth(),
    requirePlatformAdmin(),
    async (req, res) => {
      res.json(await list(undefined, parse(query, req.query)));
    },
  );

  return router;
}
