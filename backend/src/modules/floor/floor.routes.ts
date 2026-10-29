import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, isUniqueViolation, parse } from '../../http/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

const roomInput = z.object({
  branchId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
  // Workflow zone of the room's tables (dining hall, VIP room, bar).
  kind: z.enum(['HALL', 'VIP', 'BAR']).default('HALL'),
});

const tableInput = z.object({
  roomId: z.uuid(),
  name: z.string().trim().min(1).max(30),
  seats: z.number().int().min(1).max(100),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

export function floorRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('tables.manage')];

  // Waiters and cashiers need the floor plan; only tables.manage may change it.
  router.get('/floor', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('tables.manage') &&
      !auth.permissions.has('orders.view')
    )
      throw errors.forbidden();
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const manageView = auth.permissions.has('tables.manage');
    const rooms = await db.room.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        ...(manageView ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        tables: {
          where: manageView ? {} : { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        },
      },
    });
    res.json({
      branchId: branch.id,
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        sortOrder: room.sortOrder,
        isActive: room.isActive,
        kind: room.kind,
        tables: room.tables.map((table) => ({
          id: table.id,
          name: table.name,
          seats: table.seats,
          sortOrder: table.sortOrder,
          isActive: table.isActive,
          // QR tokens are needed only by managers who print table codes.
          ...(manageView ? { qrToken: table.qrToken } : {}),
        })),
      })),
    });
  });

  router.post('/rooms', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(roomInput, req.body);
    const branch = await resolveBranch(db, auth, input.branchId);
    try {
      const room = await db.$transaction(async (tx) => {
        const created = await tx.room.create({
          data: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            name: input.name,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            kind: input.kind,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: branch.id,
          actorUserId: auth.userId,
          action: 'room.create',
          entityType: 'room',
          entityId: created.id,
        });
        return created;
      });
      res.status(201).json({ id: room.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/rooms/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(roomInput.omit({ branchId: true }), req.body);
    try {
      await db.$transaction(async (tx) => {
        const room = await tx.room.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!room) throw errors.notFound();
        await resolveBranch(tx, auth, room.branchId);
        await tx.room.update({ where: { id }, data: input });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: room.branchId,
          actorUserId: auth.userId,
          action: 'room.update',
          entityType: 'room',
          entityId: id,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  router.post('/tables', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(tableInput, req.body);
    try {
      const table = await db.$transaction(async (tx) => {
        const room = await tx.room.findFirst({
          where: { id: input.roomId, tenantId: auth.tenantId },
        });
        if (!room) throw errors.validation([{ path: 'roomId' }]);
        await resolveBranch(tx, auth, room.branchId);
        const created = await tx.diningTable.create({
          data: {
            tenantId: auth.tenantId,
            branchId: room.branchId,
            roomId: room.id,
            name: input.name,
            seats: input.seats,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            qrToken: randomToken(18),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: room.branchId,
          actorUserId: auth.userId,
          action: 'table.create',
          entityType: 'table',
          entityId: created.id,
        });
        return created;
      });
      res.status(201).json({ id: table.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/tables/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(tableInput, req.body);
    try {
      await db.$transaction(async (tx) => {
        const table = await tx.diningTable.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!table) throw errors.notFound();
        await resolveBranch(tx, auth, table.branchId);
        // A table may move between rooms of the same branch only.
        const room = await tx.room.findFirst({
          where: {
            id: input.roomId,
            tenantId: auth.tenantId,
            branchId: table.branchId,
          },
        });
        if (!room) throw errors.validation([{ path: 'roomId' }]);
        await tx.diningTable.update({ where: { id }, data: input });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: table.branchId,
          actorUserId: auth.userId,
          action: 'table.update',
          entityType: 'table',
          entityId: id,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  // Printed QR codes can be invalidated (e.g. after misuse) by issuing a new token.
  router.post('/tables/:id/rotate-qr', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!table) throw errors.notFound();
      await resolveBranch(tx, auth, table.branchId);
      await tx.diningTable.update({
        where: { id },
        data: { qrToken: randomToken(18) },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: table.branchId,
        actorUserId: auth.userId,
        action: 'table.qr.rotate',
        entityType: 'table',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  const batchIdsSchema = z.object({
    ids: z.array(z.uuid()).min(1).max(100),
  });

  const ACTIVE_ORDER_STATUSES = [
    'DRAFT',
    'PENDING',
    'PLACED',
    'PREPARING',
    'READY',
    'SERVED',
  ] as const;

  // Delete / deactivate an individual dining table safely
  router.delete('/tables/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);

    const result = await db.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!table) throw errors.notFound();
      await resolveBranch(tx, auth, table.branchId);

      // Never delete a table with an active order
      const activeOrders = await tx.order.count({
        where: {
          tenantId: auth.tenantId,
          tableId: id,
          status: { in: [...ACTIVE_ORDER_STATUSES] },
        },
      });
      if (activeOrders > 0) {
        throw new AppError(409, 'TABLE_HAS_ACTIVE_ORDERS', 'tableHasOrder');
      }

      // Check historical orders; use safe soft deactivation if historical references exist
      const totalOrders = await tx.order.count({
        where: { tenantId: auth.tenantId, tableId: id },
      });

      if (totalOrders > 0) {
        await tx.diningTable.update({
          where: { id },
          data: { isActive: false },
        });
      } else {
        await tx.diningTable.delete({
          where: { id },
        });
      }

      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: table.branchId,
        actorUserId: auth.userId,
        action: 'table.delete',
        entityType: 'table',
        entityId: id,
        data: { name: table.name, deactivated: totalOrders > 0 },
      });

      return { ok: true, deactivated: totalOrders > 0 };
    });

    res.json(result);
  });

  // Restore a deactivated dining table
  router.post('/tables/:id/restore', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);

    await db.$transaction(async (tx) => {
      const table = await tx.diningTable.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!table) throw errors.notFound();
      await resolveBranch(tx, auth, table.branchId);

      await tx.diningTable.update({
        where: { id },
        data: { isActive: true },
      });

      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: table.branchId,
        actorUserId: auth.userId,
        action: 'table.restore',
        entityType: 'table',
        entityId: id,
        data: { name: table.name },
      });
    });

    res.json({ ok: true });
  });

  // Batch delete / deactivate dining tables
  router.post('/tables/batch-delete', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { ids } = parse(batchIdsSchema, req.body);

    const result = await db.$transaction(async (tx) => {
      let deactivatedCount = 0;
      let deletedCount = 0;

      for (const id of ids) {
        const table = await tx.diningTable.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!table) continue;
        await resolveBranch(tx, auth, table.branchId);

        // Never delete a table with an active order
        const activeOrders = await tx.order.count({
          where: {
            tenantId: auth.tenantId,
            tableId: id,
            status: { in: [...ACTIVE_ORDER_STATUSES] },
          },
        });
        if (activeOrders > 0) {
          throw new AppError(409, 'TABLE_HAS_ACTIVE_ORDERS', 'tableHasOrder');
        }

        const totalOrders = await tx.order.count({
          where: { tenantId: auth.tenantId, tableId: id },
        });

        if (totalOrders > 0) {
          await tx.diningTable.update({
            where: { id },
            data: { isActive: false },
          });
          deactivatedCount++;
        } else {
          await tx.diningTable.delete({
            where: { id },
          });
          deletedCount++;
        }

        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: table.branchId,
          actorUserId: auth.userId,
          action: 'table.delete',
          entityType: 'table',
          entityId: id,
          data: { name: table.name, deactivated: totalOrders > 0 },
        });
      }

      return { ok: true, deleted: deletedCount, deactivated: deactivatedCount };
    });

    res.json(result);
  });

  // Batch restore dining tables
  router.post('/tables/batch-restore', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { ids } = parse(batchIdsSchema, req.body);

    await db.$transaction(async (tx) => {
      for (const id of ids) {
        const table = await tx.diningTable.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!table) continue;
        await resolveBranch(tx, auth, table.branchId);

        await tx.diningTable.update({
          where: { id },
          data: { isActive: true },
        });

        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: table.branchId,
          actorUserId: auth.userId,
          action: 'table.restore',
          entityType: 'table',
          entityId: id,
          data: { name: table.name },
        });
      }
    });

    res.json({ ok: true, count: ids.length });
  });

  return router;
}
