import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import {
  fromLegacyLayout,
  templateSettingsOf,
} from '../../printing/receipt-template.js';
import { hashSecret } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import { passwordSchema, pinSchema } from '../auth/auth.routes.js';
import { orderSettingsOf } from '../orders/settings.js';
import {
  loadOwner,
  requireOwner,
  requireOwnerReauth,
  controlAudit,
  getOwner,
} from './owner.js';

/**
 * Owner access to the operational data of restaurants hosted on this server
 * (a customer linked to a tenant). Strictly tenant-scoped through the customer record,
 * read-only except for suspending an employee, and every read is audited. Passwords,
 * PIN hashes, tokens and one-time-code secrets are never selected.
 *
 * Restaurants that run on their own computer keep their data there: for them the
 * Owner only sees what the install reports (devices, sync ledger, summaries).
 */
export function dataRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const authed = [loadOwner(services), requireOwner()];
  // Personal data (employees, orders) needs a fresh password + code.
  const sensitive = [...authed, requireOwnerReauth(services)];
  const idParam = (value: unknown) => parse(z.uuid(), value);

  /** The tenant of a customer; hosted customers only. */
  const tenantOf = async (customerId: string) => {
    const customer = await db.controlCustomer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, tenantId: true },
    });
    if (!customer) throw errors.notFound();
    if (!customer.tenantId) throw errors.notFound();
    return { customerId: customer.id, tenantId: customer.tenantId };
  };

  const record = async (
    req: Parameters<typeof controlAudit>[1],
    ownerId: string,
    customerId: string,
    what: string,
    data?: Record<string, unknown>,
  ) =>
    controlAudit(db, req, {
      ownerId,
      customerId,
      action: `data.view.${what}`,
      entityType: 'tenant_data',
      ...(data ? { data: data as never } : {}),
    });

  router.get(
    '/control/customers/:id/data/overview',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [
        branches,
        devices,
        users,
        roles,
        openOrders,
        ordersToday,
        templates,
      ] = await Promise.all([
        db.branch.count({ where: { tenantId, deletedAt: null } }),
        db.device.count({ where: { tenantId, status: 'ACTIVE' } }),
        db.user.count({ where: { tenantId, deletedAt: null } }),
        db.role.count({ where: { tenantId } }),
        db.order.count({
          where: { tenantId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        }),
        db.order.count({ where: { tenantId, createdAt: { gte: since } } }),
        db.receiptTemplate.count({ where: { tenantId } }),
      ]);
      await record(req, owner.ownerId, customerId, 'overview');
      res.json({
        branches,
        devices,
        users,
        roles,
        openOrders,
        ordersToday,
        templates,
      });
    },
  );

  router.get(
    '/control/customers/:id/data/branches',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const rows = await db.branch.findMany({
        where: { tenantId, deletedAt: null },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          address: true,
          phone: true,
          timezone: true,
          isActive: true,
          createdAt: true,
        },
      });
      await record(req, owner.ownerId, customerId, 'branches');
      res.json({ branches: rows });
    },
  );

  router.get(
    '/control/customers/:id/data/devices',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const rows = await db.device.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        // Never the token hash.
        select: {
          id: true,
          name: true,
          panel: true,
          status: true,
          lastSeenAt: true,
          lastIp: true,
          appVersion: true,
          createdAt: true,
          branch: { select: { name: true } },
        },
      });
      await record(req, owner.ownerId, customerId, 'devices');
      res.json({
        devices: rows.map(({ branch, ...device }) => ({
          ...device,
          branch: branch.name,
        })),
      });
    },
  );

  router.get(
    '/control/customers/:id/data/roles',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const rows = await db.role.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          systemKey: true,
          name: true,
          permissions: true,
          _count: { select: { users: true } },
        },
      });
      await record(req, owner.ownerId, customerId, 'roles');
      res.json({
        roles: rows.map(({ _count, ...role }) => ({
          ...role,
          users: _count.users,
        })),
      });
    },
  );

  router.get(
    '/control/customers/:id/data/users',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const { q } = parse(
        z.object({ q: z.string().trim().max(60).optional() }),
        req.query,
      );
      const rows = await db.user.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(q
            ? {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { displayName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { displayName: 'asc' },
        take: 200,
        // No password, PIN or authenticator secrets.
        select: {
          id: true,
          username: true,
          displayName: true,
          phone: true,
          status: true,
          lastLoginAt: true,
          mfaEnabledAt: true,
          allBranches: true,
          roles: {
            select: { role: { select: { name: true, systemKey: true } } },
          },
        },
      });
      await record(req, owner.ownerId, customerId, 'users', { q: q ?? null });
      res.json({
        users: rows.map(({ roles, mfaEnabledAt, ...user }) => ({
          ...user,
          mfa: mfaEnabledAt !== null,
          roles: roles.map((row) => row.role.name),
        })),
      });
    },
  );

  // Suspend or restore an employee centrally; sessions end at once.
  router.post(
    '/control/customers/:id/data/users/:userId/status',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const userId = idParam(req.params.userId);
      const { status } = parse(
        z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }),
        req.body,
      );
      const user = await db.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null },
        select: { id: true, status: true },
      });
      if (!user) throw errors.notFound();
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { status } });
        if (status === 'DISABLED')
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: 'data.user.status',
          entityType: 'user',
          entityId: userId,
          data: { from: user.status, to: status },
        });
      });
      services.events?.publish({ type: 'config.changed', tenantId });
      res.json({ ok: true });
    },
  );

  /**
   * Forgotten password / PIN: the Owner sets a NEW secret without ever seeing the old
   * one. Only a hash is stored, the secret never reaches a log or an audit row, every
   * session of the employee ends, and nothing else about the restaurant changes
   * (orders, licence, tenant and history stay as they are).
   */
  const secretTarget = async (
    customerId: string,
    tenantId: string,
    id: string,
  ) => {
    const user = await db.user.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, username: true },
    });
    if (!user) throw errors.notFound();
    return { ...user, customerId };
  };

  router.post(
    '/control/customers/:id/data/users/:userId/password',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const userId = idParam(req.params.userId);
      const { password } = parse(
        z.object({ password: z.string().max(128), confirm: z.literal(true) }),
        req.body,
      );
      if (!passwordSchema.safeParse(password).success)
        throw new AppError(400, 'WEAK_PASSWORD', 'weakPassword');
      await secretTarget(customerId, tenantId, userId);
      const passwordHash = await hashSecret(password);
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            passwordHash,
            passwordChangedAt: new Date(),
            // The employee must choose their own password at the next sign-in.
            mustChangePassword: true,
            failedLoginCount: 0,
            lockedUntil: null,
          },
        });
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'owner_password_reset' },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: 'data.user.password.reset',
          entityType: 'user',
          entityId: userId,
        });
        await audit(tx, req, {
          tenantId,
          action: 'user.password.reset.owner',
          entityType: 'user',
          entityId: userId,
        });
      });
      services.events?.publish({ type: 'config.changed', tenantId });
      res.json({ ok: true });
    },
  );

  router.post(
    '/control/customers/:id/data/users/:userId/pin',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const userId = idParam(req.params.userId);
      const { pin } = parse(
        z.object({ pin: pinSchema.nullable(), confirm: z.literal(true) }),
        req.body,
      );
      await secretTarget(customerId, tenantId, userId);
      const pinHash = pin
        ? await hashSecret(services.secrets.pepperPin(userId, pin))
        : null;
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            pinHash,
            pinChangedAt: new Date(),
            failedPinCount: 0,
            pinLockedUntil: null,
          },
        });
        await tx.session.updateMany({
          where: { userId, authMethod: 'PIN', revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'owner_pin_reset' },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          customerId,
          action: pin ? 'data.user.pin.set' : 'data.user.pin.remove',
          entityType: 'user',
          entityId: userId,
        });
        await audit(tx, req, {
          tenantId,
          action: pin ? 'user.pin.set.owner' : 'user.pin.remove.owner',
          entityType: 'user',
          entityId: userId,
        });
      });
      services.events?.publish({ type: 'config.changed', tenantId });
      res.json({ ok: true });
    },
  );

  router.get(
    '/control/customers/:id/data/settings',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const [profile, delegated, templates] = await Promise.all([
        db.tenantProfile.findUnique({ where: { tenantId } }),
        db.featureSetting.findMany({ where: { tenantId } }),
        db.receiptTemplate.findMany({
          where: { tenantId },
          orderBy: { name: 'asc' },
          include: { assignments: true },
        }),
      ]);
      await record(req, owner.ownerId, customerId, 'settings');
      res.json({
        // Business profile and workflow, without any payment/fiscal secrets.
        profile: profile
          ? {
              legalName: profile.legalName,
              taxId: profile.taxId,
              phone: profile.phone,
              serviceChargeBp: profile.serviceChargeBp,
              orderSettings: orderSettingsOf(profile.orderSettings),
            }
          : null,
        delegated: delegated.map((row) => ({
          feature: row.featureKey,
          role: row.roleKey,
          enabled: row.enabled,
          params: row.params,
          updatedAt: row.updatedAt,
        })),
        defaultReceipt: fromLegacyLayout(profile?.receiptSettings),
        receiptTemplates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          kind: template.kind,
          widthMm: templateSettingsOf(template.settings).widthMm,
          assignments: template.assignments.map((row) => ({
            type: row.targetType,
            targetId: row.targetId,
          })),
        })),
      });
    },
  );

  router.get(
    '/control/customers/:id/data/orders',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const query = parse(
        z.object({
          q: z.string().trim().max(60).optional(),
          status: z
            .enum([
              'DRAFT',
              'PENDING',
              'PLACED',
              'PREPARING',
              'READY',
              'SERVED',
              'COMPLETED',
              'CANCELLED',
            ])
            .optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        req.query,
      );
      const number =
        query.q && /^\d{1,9}$/.test(query.q) ? Number(query.q) : null;
      const rows = await db.order.findMany({
        where: {
          tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.q
            ? {
                OR: [
                  ...(number !== null ? [{ number }] : []),
                  {
                    customerName: {
                      contains: query.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  { customerPhone: { contains: query.q } },
                  {
                    table: {
                      name: { contains: query.q, mode: 'insensitive' as const },
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        select: {
          id: true,
          number: true,
          type: true,
          status: true,
          total: true,
          paidTotal: true,
          refundedTotal: true,
          createdAt: true,
          customerName: true,
          table: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      await record(req, owner.ownerId, customerId, 'orders', {
        q: query.q ?? null,
        status: query.status ?? null,
      });
      res.json({
        orders: rows.map(({ table, branch, ...order }) => ({
          ...order,
          table: table?.name ?? null,
          branch: branch.name,
        })),
      });
    },
  );

  router.get(
    '/control/customers/:id/data/orders/:orderId',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const { customerId, tenantId } = await tenantOf(idParam(req.params.id));
      const orderId = idParam(req.params.orderId);
      // The order must belong to the customer's restaurant.
      const order = await db.order.findFirst({
        where: { id: orderId, tenantId },
        include: {
          items: true,
          payments: true,
          table: { select: { name: true } },
          branch: { select: { name: true } },
        },
      });
      if (!order) throw errors.notFound();
      const events = await db.orderEvent.findMany({
        where: { orderId, tenantId },
        orderBy: { createdAt: 'asc' },
        select: { type: true, createdAt: true, actorId: true, data: true },
        take: 200,
      });
      await record(req, owner.ownerId, customerId, 'order', { orderId });
      res.json({
        id: order.id,
        number: order.number,
        type: order.type,
        status: order.status,
        branch: order.branch.name,
        table: order.table?.name ?? null,
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        serviceCharge: order.serviceCharge,
        total: order.total,
        paidTotal: order.paidTotal,
        refundedTotal: order.refundedTotal,
        createdAt: order.createdAt,
        items: order.items.map((item) => ({
          name: item.productName,
          variant: item.variantName,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
          status: item.status,
        })),
        payments: order.payments.map((payment) => ({
          method: payment.method,
          amount: payment.amount,
          createdAt: payment.createdAt,
        })),
        events,
      });
    },
  );

  return router;
}
