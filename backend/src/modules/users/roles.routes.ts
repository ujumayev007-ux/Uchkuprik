import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, isUniqueViolation, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { isPermission } from '../auth/permissions.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
  type AuthContext,
} from '../auth/session.js';

const roleInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).nullable().optional(),
  permissions: z
    .array(z.string().refine(isPermission))
    .max(200)
    .transform((list) => [...new Set(list)].sort()),
});

function assertGrantable(auth: AuthContext, permissions: string[]) {
  if (auth.roleKeys.includes('owner')) return;
  if (permissions.some((key) => !auth.permissions.has(key as never)))
    throw errors.forbidden();
}

export function rolesRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [
    requireAuth(),
    requirePermission('roles.manage'),
    requireRecentAuth(services),
  ];

  router.get(
    '/roles',
    requireAuth(),
    requirePermission('users.view'),
    async (_req, res) => {
      const auth = getAuth(res);
      const roles = await db.role.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: [
          { systemKey: { sort: 'asc', nulls: 'last' } },
          { name: 'asc' },
        ],
        include: { _count: { select: { users: true } } },
      });
      res.json({
        roles: roles.map((role) => ({
          id: role.id,
          name: role.name,
          description: role.description,
          systemKey: role.systemKey,
          permissions: role.permissions,
          userCount: role._count.users,
        })),
      });
    },
  );

  router.post('/roles', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(roleInput, req.body);
    assertGrantable(auth, input.permissions);
    try {
      const role = await db.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: {
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description ?? null,
            permissions: input.permissions,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'role.create',
          entityType: 'role',
          entityId: created.id,
          data: { permissions: input.permissions },
        });
        return created;
      });
      res.status(201).json({ id: role.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/roles/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(roleInput, req.body);
    assertGrantable(auth, input.permissions);
    try {
      await db.$transaction(async (tx) => {
        const role = await tx.role.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!role) throw errors.notFound();
        // The owner role always keeps every permission so the tenant cannot lock itself out.
        if (role.systemKey === 'owner') throw errors.forbidden();
        assertGrantable(auth, role.permissions);
        await tx.role.update({
          where: { id },
          data: {
            name: input.name,
            description: input.description ?? null,
            permissions: input.permissions,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'role.update',
          entityType: 'role',
          entityId: id,
          data: { before: role.permissions, after: input.permissions },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  router.delete('/roles/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const role = await tx.role.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { _count: { select: { users: true } } },
      });
      if (!role) throw errors.notFound();
      if (role.systemKey || role._count.users > 0) throw errors.conflict();
      await tx.role.delete({ where: { id } });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'role.delete',
        entityType: 'role',
        entityId: id,
      });
    });
    res.status(204).end();
  });

  return router;
}
