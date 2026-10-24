import { Router } from 'express';
import { z } from 'zod';
import { assertWithinLimit } from '../billing/entitlements.js';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import { isLocalClient } from '../control/network.js';
import {
  canAccessBranch,
  cookieNames,
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
  setCookie,
  readCookie,
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
          appVersion: device.appVersion,
          userAgent: device.userAgent,
          panel: device.panel,
          lastIp: device.lastIp,
          createdAt: device.createdAt,
        })),
      });
    },
  );

  /**
   * Heartbeat from an installed terminal: records last contact and app version for the
   * fleet view. Identified only by the httpOnly device cookie; no user session needed.
   */
  router.post('/devices/heartbeat', async (req, res) => {
    const token = readCookie(req, cookieNames(services.secureCookies).device);
    const { version } = parse(
      z.object({ version: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/) }),
      req.body,
    );
    if (!token) {
      res.json({ registered: false });
      return;
    }
    const result = await db.device.updateMany({
      where: { tokenHash: sha256(token), status: 'ACTIVE' },
      data: {
        lastSeenAt: services.now?.() ?? new Date(),
        appVersion: version,
        userAgent: req.get('user-agent')?.slice(0, 200) ?? null,
        lastIp: req.ip ?? null,
      },
    });
    res.json({ registered: result.count > 0 });
  });

  // Registers the browser that sends this request. The device token is only ever
  // delivered as an httpOnly cookie, so it cannot be copied from the UI.
  router.post('/devices/register', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid(),
        name: z.string().trim().min(2).max(60),
        // Panel the terminal serves (offline rules treat CASHIER specially).
        panel: z
          .enum(['CASHIER', 'KITCHEN', 'WAITER', 'DISPLAY', 'OTHER'])
          .default('OTHER'),
      }),
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
    // The restaurant Admin registers a new terminal within license limits; active immediately.
    const status = 'ACTIVE';
    const device = await db.$transaction(async (tx) => {
      await assertWithinLimit(tx, auth.tenantId, 'devices');
      const created = await tx.device.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          name: input.name,
          panel: input.panel,
          tokenHash: sha256(token),
          registeredById: auth.userId,
          status,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'device.register',
        entityType: 'device',
        entityId: created.id,
        data: { status, panel: input.panel, name: input.name },
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
    res.status(201).json({ id: device.id, status: device.status });
  });

  /**
   * Queue TV application, first start: the screen registers itself with no password or
   * PIN. From the restaurant's local network, it registers as an ACTIVE display so it
   * can show the live queue immediately. Admin can revoke/manage the TV device at any time.
   */
  router.post('/devices/display/register', async (req, res) => {
    // Restaurant install only (a hosted server has many restaurants), own network only.
    if (!services.selfHosted || !isLocalClient(req.socket.remoteAddress))
      throw errors.forbidden();
    const input = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.body ?? {},
    );
    const names = cookieNames(services.secureCookies);
    const existing = readCookie(req, names.device);
    if (existing) {
      const device = await db.device.findUnique({
        where: { tokenHash: sha256(existing) },
        select: { id: true, status: true, panel: true },
      });
      if (device && device.status !== 'REVOKED') {
        res.json({ id: device.id, status: device.status });
        return;
      }
    }
    // The restaurant of this install (same choice as the control runtime's link).
    const tenant = await db.tenant.findFirst({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true },
    });
    if (tenant?.status !== 'ACTIVE') throw errors.forbidden();
    const tenantId = tenant.id;
    const branches = await db.branch.findMany({
      where: { tenantId, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    const branch =
      branches.length === 1
        ? branches[0]
        : branches.find((b) => b.id === input.branchId);
    // Several branches: the TV shows them once and the person setting it up taps one.
    if (!branch)
      throw new AppError(409, 'BRANCH_REQUIRED', 'conflict', { branches });
    // Unapproved self-registered screens are capped, so the device list can not be flooded.
    const waiting = await db.device.count({
      where: { tenantId, panel: 'DISPLAY', status: 'PENDING' },
    });
    if (waiting >= 5) throw new AppError(429, 'RATE_LIMITED', 'rateLimited');
    const owner = await db.user.findFirst({
      where: { tenantId, roles: { some: { role: { systemKey: 'owner' } } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!owner) throw errors.forbidden();
    const token = randomToken();
    const device = await db.$transaction(async (tx) => {
      await assertWithinLimit(tx, tenantId, 'devices');
      const created = await tx.device.create({
        data: {
          tenantId,
          branchId: branch.id,
          name: `TV ${new Date().toISOString().slice(0, 10)} ${randomToken().slice(0, 4).toUpperCase()}`,
          panel: 'DISPLAY',
          tokenHash: sha256(token),
          registeredById: owner.id,
          status: 'ACTIVE',
          userAgent: req.get('user-agent')?.slice(0, 200) ?? null,
          lastIp: req.ip ?? null,
        },
      });
      await audit(tx, req, {
        tenantId,
        branchId: branch.id,
        action: 'device.register',
        entityType: 'device',
        entityId: created.id,
        data: { status: 'ACTIVE', panel: 'DISPLAY', self: true },
      });
      return created;
    });
    setCookie(res, services, names.device, token, DEVICE_COOKIE_MS);
    res.status(201).json({ id: device.id, status: device.status });
  });

  router.post('/devices/:id/approve', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      await assertWithinLimit(tx, auth.tenantId, 'devices');
      const result = await tx.device.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'PENDING' },
        data: { status: 'ACTIVE' },
      });
      if (result.count === 0) throw errors.notFound();
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'device.approve',
        entityType: 'device',
        entityId: id,
      });
    });
    res.json({ ok: true });
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
