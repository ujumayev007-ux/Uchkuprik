import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { errors, parse } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import {
  canAccessBranch,
  cookieNames,
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
  setCookie,
} from '../auth/session.js';

const DEVICE_COOKIE_MS = 365 * 24 * 60 * 60_000;

export function devicesRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [
    requireAuth(),
    requirePermission('devices.manage'),
    requireRecentAuth(services),
  ];

  router.get(
    '/devices',
    requireAuth(),
    requirePermission('devices.manage'),
    async (_req, res) => {
      const auth = getAuth(res);
      const devices = await db.device.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { createdAt: 'desc' },
        include: { branch: { select: { name: true } } },
      });
      res.json({
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          branchId: device.branchId,
          branchName: device.branch.name,
          status: device.status,
          lastSeenAt: device.lastSeenAt,
          createdAt: device.createdAt,
        })),
      });
    },
  );

  // Registers the browser that sends this request. The device token is only ever
  // delivered as an httpOnly cookie, so it cannot be copied from the UI.
  router.post('/devices/register', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({ branchId: z.uuid(), name: z.string().trim().min(2).max(60) }),
      req.body,
    );
    const branch = await db.branch.findFirst({
      where: {
        id: input.branchId,
        tenantId: auth.tenantId,
        deletedAt: null,
        isActive: true,
      },
    });
    if (!branch || !canAccessBranch(auth, branch.id)) throw errors.forbidden();
    const token = randomToken();
    const device = await db.$transaction(async (tx) => {
      const created = await tx.device.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          name: input.name,
          tokenHash: sha256(token),
          registeredById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'device.register',
        entityType: 'device',
        entityId: created.id,
      });
      return created;
    });
    setCookie(
      res,
      services,
      cookieNames(services.secureCookies).device,
      token,
      DEVICE_COOKIE_MS,
    );
    res.status(201).json({ id: device.id });
  });

  router.post('/devices/:id/revoke', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const result = await tx.device.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now() },
      });
      if (result.count === 0) throw errors.notFound();
      await tx.session.updateMany({
        where: { deviceId: id, revokedAt: null },
        data: { revokedAt: now(), revokeReason: 'device_revoked' },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'device.revoke',
        entityType: 'device',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  return router;
}
