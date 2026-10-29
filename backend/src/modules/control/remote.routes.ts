import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { executeOp, isSnapshot, OP_KINDS, OP_PAYLOADS } from '../remote/ops.js';
import {
  controlAudit,
  getOwner,
  loadOwner,
  requireOwner,
  requireOwnerReauth,
} from './owner.js';

const MAX_DELIVERED = 10;

/** Operations a restaurant has not finished yet (delivered with its heartbeat). */
export async function opsForDevice(db: Db, customerId: string, at: Date) {
  const ops = await db.controlRemoteOp.findMany({
    where: { customerId, status: { in: ['QUEUED', 'SENT'] } },
    orderBy: { createdAt: 'asc' },
    take: MAX_DELIVERED,
    select: { id: true, kind: true, payload: true },
  });
  if (ops.length)
    await db.controlRemoteOp.updateMany({
      where: { id: { in: ops.map((op) => op.id) }, status: 'QUEUED' },
      data: { status: 'SENT', sentAt: at },
    });
  return ops;
}

/**
 * Owner → Restoran boshqaruvi: snapshots of a restaurant's menu, staff, floor,
 * settings, inventory and sales, and small audited changes. Hosted restaurants are
 * changed at once; restaurants on their own computer receive the operation with the
 * signed heartbeat answer and run it exactly once (results come back signed).
 */
export function remoteRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const authed = [loadOwner(services), requireOwner()];
  const reauth = requireOwnerReauth(services);
  const idParam = (value: unknown) => parse(z.uuid(), value);
  const now = () => services.now?.() ?? new Date();

  // Personal data and every change need a fresh password + code.
  const needsReauth = (kind: string) => !isSnapshot(kind) || kind === 'snapshot.staff';
  const checkReauth = (req: Request, res: Response) =>
    new Promise<void>((resolve, reject) =>
      reauth(req, res, (error?: unknown) => (error ? reject(error) : resolve())),
    );

  router.get('/control/customers/:id/remote', ...authed, async (req, res) => {
    const id = idParam(req.params.id);
    const customer = await db.controlCustomer.findUnique({
      where: { id },
      select: { tenantId: true },
    });
    if (!customer) throw errors.notFound();
    const [ops, activation] = await Promise.all([
      db.controlRemoteOp.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          kind: true,
          payload: true,
          status: true,
          error: true,
          createdAt: true,
          doneAt: true,
        },
      }),
      db.controlActivation.findFirst({
        where: { customerId: id, status: 'ACTIVE' },
        orderBy: { lastHeartbeatAt: 'desc' },
        select: { capabilities: true, lastHeartbeatAt: true },
      }),
    ]);
    // The newest finished snapshot of each kind.
    const snapshots: Record<string, { result: unknown; doneAt: Date | null }> = {};
    for (const kind of OP_KINDS.filter(isSnapshot)) {
      const done = await db.controlRemoteOp.findFirst({
        where: { customerId: id, kind, status: 'DONE' },
        orderBy: { doneAt: 'desc' },
        select: { result: true, doneAt: true },
      });
      if (done) snapshots[kind] = done;
    }
    res.json({
      hosted: customer.tenantId !== null,
      compatible:
        customer.tenantId !== null ||
        (activation?.capabilities.includes('remote_ops') ?? false),
      lastContact: activation?.lastHeartbeatAt ?? null,
      snapshots,
      ops,
    });
  });

  router.post('/control/customers/:id/remote/ops', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const customerId = idParam(req.params.id);
    const input = parse(
      z.object({ kind: z.enum(OP_KINDS as [string, ...string[]]), payload: z.unknown().optional() }),
      req.body,
    );
    if (needsReauth(input.kind)) await checkReauth(req, res);
    const payload = OP_PAYLOADS[input.kind as keyof typeof OP_PAYLOADS].parse(
      input.payload ?? {},
    ) as Prisma.InputJsonValue;
    const customer = await db.controlCustomer.findUnique({
      where: { id: customerId },
      select: { tenantId: true },
    });
    if (!customer) throw errors.notFound();
    // One snapshot request of a kind at a time.
    if (isSnapshot(input.kind)) {
      const waiting = await db.controlRemoteOp.findFirst({
        where: { customerId, kind: input.kind, status: { in: ['QUEUED', 'SENT'] } },
        select: { id: true, status: true },
      });
      if (waiting) {
        res.json(waiting);
        return;
      }
    }
    const op = await db.controlRemoteOp.create({
      data: { customerId, kind: input.kind, payload, createdById: owner.ownerId },
    });
    await controlAudit(db, req, {
      ownerId: owner.ownerId,
      customerId,
      action: `remote.${input.kind}`,
      entityType: 'remote_op',
      entityId: op.id,
      ...(isSnapshot(input.kind) ? {} : { data: { payload } }),
    });
    // A restaurant hosted on this server: run now.
    if (customer.tenantId) {
      try {
        const result = await executeOp(db, customer.tenantId, input.kind, payload);
        await db.controlRemoteOp.update({
          where: { id: op.id },
          data: {
            status: 'DONE',
            result: (result ?? null) as Prisma.InputJsonValue,
            doneAt: now(),
          },
        });
      } catch (error) {
        await db.controlRemoteOp.update({
          where: { id: op.id },
          data: {
            status: 'FAILED',
            error: error instanceof AppError ? error.code : 'FAILED',
            doneAt: now(),
          },
        });
      }
    }
    const saved = await db.controlRemoteOp.findUniqueOrThrow({
      where: { id: op.id },
      select: { id: true, status: true, error: true },
    });
    res.status(201).json(saved);
  });

  return router;
}
