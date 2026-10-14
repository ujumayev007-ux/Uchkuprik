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
  // Employee, order (number or id), outcome and period filters.
  actorUserId: z.uuid().optional(),
  orderNumber: z.coerce.number().int().min(1).max(1_000_000).optional(),
  entityId: z.string().trim().max(60).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
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
    // Order numbers repeat daily: match every order of the tenant with that number.
    const orderIds =
      input.orderNumber && tenantId
        ? (
            await db.order.findMany({
              where: { tenantId, number: input.orderNumber },
              select: { id: true },
              take: 200,
            })
          ).map((order) => order.id)
        : null;
    const rows = await db.auditLog.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(input.action ? { action: { startsWith: input.action } } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(orderIds
          ? { entityId: { in: orderIds } }
          : input.entityId
            ? { entityId: input.entityId }
            : {}),
        ...(input.from || input.to
          ? {
              createdAt: {
                ...(input.from ? { gte: input.from } : {}),
                ...(input.to ? { lte: input.to } : {}),
              },
            }
          : {}),
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
        roles: row.roles,
        session: row.sessionId ? row.sessionId.slice(-6) : null,
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
