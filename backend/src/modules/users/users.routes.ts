import { Router } from 'express';
import { z } from 'zod';
import { assertWithinLimit } from '../billing/entitlements.js';
import { catalogByKey } from '../control/catalog.js';
import { evaluateFeature, resolveParams } from '../control/policy.js';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { hashSecret, verifySecret } from '../../lib/crypto.js';
import { audit } from '../audit/audit.js';
import { passwordSchema, pinSchema } from '../auth/auth.routes.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
  type AuthContext,
} from '../auth/session.js';

const userFields = z.object({
  displayName: z.string().trim().min(2).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .nullable()
    .optional(),
  roleIds: z.array(z.uuid()).max(10),
  allBranches: z.boolean(),
  branchIds: z.array(z.uuid()).max(200),
});

const isOwner = (auth: AuthContext) => auth.roleKeys.includes('owner');

/**
 * Prevents privilege escalation: an actor may only grant or edit permissions they hold.
 * Owners hold every permission and may manage everyone, including other owners.
 */
function assertWithinActor(auth: AuthContext, permissions: Iterable<string>) {
  if (isOwner(auth)) return;
  for (const key of permissions)
    if (!auth.permissions.has(key as never)) throw errors.forbidden();
}

async function loadRoles(tx: Tx, auth: AuthContext, roleIds: string[]) {
  const roles = await tx.role.findMany({
    where: { tenantId: auth.tenantId, id: { in: roleIds } },
  });
  if (roles.length !== new Set(roleIds).size)
    throw errors.validation([{ path: 'roleIds' }]);
  if (roles.some((role) => role.systemKey === 'owner') && !isOwner(auth))
    throw errors.forbidden();
  assertWithinActor(
    auth,
    roles.flatMap((role) => role.permissions),
  );
  return roles;
}

/**
 * Owner-set cap on active staff per role (feature `staff.limits`; 0 = unlimited). Counts
 * everybody holding the role except the person being changed, so editing a user who
 * already holds it is never blocked by their own seat.
 */
async function assertRoleSeats(
  services: Services,
  tx: Tx,
  tenantId: string,
  roles: { systemKey: string | null }[],
  exceptUserId: string | null,
) {
  const def = catalogByKey.get('staff.limits');
  if (!def || !services.controlView) return;
  const view = await services.controlView(tenantId);
  if (!evaluateFeature(view.policy, def, [], view.adminSettings).online) return;
  const limits = resolveParams(view.policy, def, [], view.adminParams);
  for (const role of roles) {
    const max = role.systemKey ? limits[role.systemKey] : undefined;
    if (typeof max !== 'number' || max <= 0) continue;
    const taken = await tx.user.count({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
        roles: { some: { role: { systemKey: role.systemKey } } },
      },
    });
    if (taken >= max)
      throw new AppError(409, 'STAFF_LIMIT', 'staffLimit', {
        role: role.systemKey,
        max,
      });
  }
}

async function assertBranches(tx: Tx, auth: AuthContext, branchIds: string[]) {
  const count = await tx.branch.count({
    where: { tenantId: auth.tenantId, id: { in: branchIds }, deletedAt: null },
  });
  if (count !== new Set(branchIds).size)
    throw errors.validation([{ path: 'branchIds' }]);
  if (!auth.allBranches && branchIds.some((id) => !auth.branchIds.includes(id)))
    throw errors.forbidden();
}

async function loadTarget(tx: Tx, auth: AuthContext, id: string) {
  const user = await tx.user.findFirst({
    where: { id, tenantId: auth.tenantId, deletedAt: null },
    include: { roles: { include: { role: true } } },
  });
  if (!user) throw errors.notFound();
  assertWithinActor(
    auth,
    user.roles.flatMap(({ role }) => role.permissions),
  );
  return user;
}

/** Must run inside the transaction that removes owner access, after the change. */
async function assertOwnerRemains(tx: Tx, tenantId: string) {
  const owners = await tx.user.count({
    where: {
      tenantId,
      status: 'ACTIVE',
      deletedAt: null,
      roles: { some: { role: { systemKey: 'owner' } } },
    },
  });
  if (owners === 0) throw new AppError(409, 'LAST_OWNER', 'lastOwner');
}

export function usersRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [
    requireAuth(),
    requirePermission('users.manage'),
    requireRecentAuth(services),
  ];

  router.get(
    '/users',
    requireAuth(),
    requirePermission('users.view'),
    async (_req, res) => {
      const auth = getAuth(res);
      const users = await db.user.findMany({
        where: { tenantId: auth.tenantId, deletedAt: null },
        orderBy: { displayName: 'asc' },
        include: {
          roles: { select: { roleId: true } },
          branches: { select: { branchId: true } },
        },
      });
      res.json({
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          phone: user.phone,
          status: user.status,
          allBranches: user.allBranches,
          branchIds: user.branches.map(({ branchId }) => branchId),
          roleIds: user.roles.map(({ roleId }) => roleId),
          hasPassword: user.passwordHash !== null,
          hasPin: user.pinHash !== null,
          mfaEnabled: user.mfaEnabledAt !== null,
          locked:
            (user.lockedUntil !== null && user.lockedUntil > now()) ||
            (user.pinLockedUntil !== null && user.pinLockedUntil > now()),
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
        })),
      });
    },
  );

  /**
   * Every active employee of the restaurant has their own PIN: one already given to
   * another active employee is refused (PINs are stored hashed, so each is checked).
   */
  const assertPinFree = async (
    tenantId: string,
    pin: string,
    exceptUserId: string | null,
  ) => {
    const others = await db.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        pinHash: { not: null },
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { id: true, pinHash: true },
    });
    for (const other of others)
      if (
        other.pinHash &&
        (await verifySecret(services.secrets.pepperPin(other.id, pin), other.pinHash))
      )
        throw new AppError(409, 'PIN_IN_USE', 'pinInUse');
  };

  router.post('/users', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      userFields.extend({
        username: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9._-]{3,40}$/),
        password: passwordSchema.optional(),
        pin: pinSchema.optional(),
      }),
      req.body,
    );
    if (!input.password && !input.pin)
      throw errors.validation([{ path: 'password' }]);
    if (input.pin) await assertPinFree(auth.tenantId, input.pin, null);
    const passwordHash = input.password
      ? await hashSecret(input.password)
      : null;
    const pinId = crypto.randomUUID();
    try {
      const user = await db.$transaction(async (tx) => {
        await assertWithinLimit(tx, auth.tenantId, 'users');
        const chosen = await loadRoles(tx, auth, input.roleIds);
        await assertRoleSeats(services, tx, auth.tenantId, chosen, null);
        if (!input.allBranches) await assertBranches(tx, auth, input.branchIds);
        else if (!auth.allBranches) throw errors.forbidden();
        const pinHash = input.pin
          ? await hashSecret(services.secrets.pepperPin(pinId, input.pin))
          : null;
        const created = await tx.user.create({
          data: {
            id: pinId,
            tenantId: auth.tenantId,
            username: input.username,
            displayName: input.displayName,
            phone: input.phone ?? null,
            passwordHash,
            passwordChangedAt: passwordHash ? now() : null,
            mustChangePassword: passwordHash !== null,
            pinHash,
            pinChangedAt: pinHash ? now() : null,
            allBranches: input.allBranches,
          },
        });
        await tx.userRole.createMany({
          data: input.roleIds.map((roleId) => ({
            tenantId: auth.tenantId,
            userId: created.id,
            roleId,
          })),
        });
        if (!input.allBranches)
          await tx.userBranch.createMany({
            data: input.branchIds.map((branchId) => ({
              tenantId: auth.tenantId,
              userId: created.id,
              branchId,
            })),
          });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'user.create',
          entityType: 'user',
          entityId: created.id,
          data: { username: created.username, roleIds: input.roleIds },
        });
        return created;
      });
      res.status(201).json({ id: user.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/users/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(userFields, req.body);
    await db.$transaction(async (tx) => {
      const current = await loadTarget(tx, auth, id);
      const chosen = await loadRoles(tx, auth, input.roleIds);
      if (current.status === 'ACTIVE')
        await assertRoleSeats(services, tx, auth.tenantId, chosen, id);
      if (!input.allBranches) await assertBranches(tx, auth, input.branchIds);
      else if (!auth.allBranches) throw errors.forbidden();
      await tx.user.update({
        where: { id },
        data: {
          displayName: input.displayName,
          phone: input.phone ?? null,
          allBranches: input.allBranches,
        },
      });
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({
        data: input.roleIds.map((roleId) => ({
          tenantId: auth.tenantId,
          userId: id,
          roleId,
        })),
      });
      await tx.userBranch.deleteMany({ where: { userId: id } });
      if (!input.allBranches)
        await tx.userBranch.createMany({
          data: input.branchIds.map((branchId) => ({
            tenantId: auth.tenantId,
            userId: id,
            branchId,
          })),
        });
      await assertOwnerRemains(tx, auth.tenantId);
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        data: { roleIds: input.roleIds, allBranches: input.allBranches },
      });
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/status', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { status } = parse(
      z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }),
      req.body,
    );
    if (id === auth.userId) throw errors.forbidden();
    await db.$transaction(async (tx) => {
      const target = await loadTarget(tx, auth, id);
      if (status === 'ACTIVE' && target.status !== 'ACTIVE') {
        await assertWithinLimit(tx, auth.tenantId, 'users');
        await assertRoleSeats(
          services,
          tx,
          auth.tenantId,
          target.roles.map(({ role }) => role),
          id,
        );
      }
      await tx.user.update({ where: { id }, data: { status } });
      if (status === 'DISABLED') {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: now(), revokeReason: 'user_disabled' },
        });
        await assertOwnerRemains(tx, auth.tenantId);
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: status === 'DISABLED' ? 'user.disable' : 'user.enable',
        entityType: 'user',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/password', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { password } = parse(z.object({ password: z.string() }), req.body);
    if (!passwordSchema.safeParse(password).success)
      throw new AppError(400, 'WEAK_PASSWORD', 'weakPassword');
    const passwordHash = await hashSecret(password);
    await db.$transaction(async (tx) => {
      await loadTarget(tx, auth, id);
      await tx.user.update({
        where: { id },
        data: {
          passwordHash,
          passwordChangedAt: now(),
          mustChangePassword: id !== auth.userId,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null, id: { not: auth.sessionId } },
        data: { revokedAt: now(), revokeReason: 'password_reset' },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'user.password.reset',
        entityType: 'user',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/pin', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { pin } = parse(z.object({ pin: pinSchema.nullable() }), req.body);
    if (pin) await assertPinFree(auth.tenantId, pin, id);
    const pinHash = pin
      ? await hashSecret(services.secrets.pepperPin(id, pin))
      : null;
    await db.$transaction(async (tx) => {
      await loadTarget(tx, auth, id);
      await tx.user.update({
        where: { id },
        data: {
          pinHash,
          pinChangedAt: now(),
          failedPinCount: 0,
          pinLockedUntil: null,
        },
      });
      await tx.session.updateMany({
        where: { userId: id, authMethod: 'PIN', revokedAt: null },
        data: { revokedAt: now(), revokeReason: 'pin_reset' },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: pin ? 'user.pin.set' : 'user.pin.remove',
        entityType: 'user',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/unlock', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      await loadTarget(tx, auth, id);
      await tx.user.update({
        where: { id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          failedPinCount: 0,
          pinLockedUntil: null,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'user.unlock',
        entityType: 'user',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  router.post('/users/:id/sessions/revoke', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      await loadTarget(tx, auth, id);
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null, id: { not: auth.sessionId } },
        data: { revokedAt: now(), revokeReason: 'admin_revoked' },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'user.sessions.revoke',
        entityType: 'user',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  return router;
}
