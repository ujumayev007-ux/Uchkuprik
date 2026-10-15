import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { billingNotice } from '../billing/notice.js';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import {
  hashSecret,
  sha256,
  verifyAgainstDummy,
  verifySecret,
} from '../../lib/crypto.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../lib/totp.js';
import { messages } from '../../messages.js';
import { audit } from '../audit/audit.js';
import { permissionCatalog } from './permissions.js';
import {
  canAccessBranch,
  clearCookie,
  cookieNames,
  createSession,
  getAuth,
  readCookie,
  requireAuth,
  requireRecentAuth,
  setCookie,
  type AuthContext,
} from './session.js';

const LOCK_THRESHOLD = 5;
const LOCK_MS = 15 * 60_000;

export const passwordSchema = z
  .string()
  .min(10)
  .max(128)
  .refine((value) => /\p{L}/u.test(value) && /\d/.test(value), 'weak');
export const pinSchema = z.string().regex(/^\d{4}$/);
const slugSchema = z.string().trim().toLowerCase().min(3).max(40);
const usernameSchema = z.string().trim().toLowerCase().min(3).max(40);

export function publicAuth(auth: AuthContext) {
  return {
    userId: auth.userId,
    tenantId: auth.tenantId,
    tenantKind: auth.tenantKind,
    username: auth.username,
    displayName: auth.displayName,
    isPlatformAdmin: auth.isPlatformAdmin,
    authMethod: auth.authMethod,
    permissions: [...auth.permissions].sort(),
    roleKeys: auth.roleKeys,
    allBranches: auth.allBranches,
    branchIds: auth.branchIds,
    activeBranchId: auth.activeBranchId,
    deviceId: auth.deviceId,
    mfaEnabled: auth.mfaEnabled,
    mfaVerified: auth.mfaVerified,
    mfaSetupRequired: auth.mfaPolicyRequired && !auth.mfaEnabled,
    mustChangePassword: auth.mustChangePassword,
    entitlements: auth.entitlements,
    financial: auth.financial,
    control: {
      mode: auth.control.mode,
      reason: auth.control.reason,
      offlineUntil: auth.control.offlineUntil,
    },
  };
}

async function findDevice(services: Services, req: Request) {
  const token = readCookie(req, cookieNames(services.secureCookies).device);
  if (!token) return null;
  const device = await services.db.device.findUnique({
    where: { tokenHash: sha256(token) },
    include: { tenant: true, branch: true },
  });
  if (
    !device ||
    device.status !== 'ACTIVE' ||
    device.tenant.status !== 'ACTIVE' ||
    !device.branch.isActive ||
    device.branch.deletedAt
  )
    return null;
  return device;
}

export function authRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const names = cookieNames(services.secureCookies);
  // Per-IP limit on credential endpoints in addition to per-account lockout.
  const credentialLimiter = rateLimit({
    windowMs: 60_000,
    limit: services.limits?.credentialsPerMinute ?? 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });

  router.get('/permissions', requireAuth(), (_req, res) => {
    res.json({
      permissions: Object.entries(permissionCatalog).map(([key, label]) => ({
        key,
        label,
      })),
    });
  });

  router.post('/auth/login', credentialLimiter, async (req, res) => {
    const input = parse(
      z.object({
        tenant: slugSchema,
        username: usernameSchema,
        password: z.string().min(1).max(128),
      }),
      req.body,
    );
    const user = await db.user.findFirst({
      where: {
        tenant: { slug: input.tenant },
        username: input.username,
        deletedAt: null,
      },
      include: { tenant: true },
    });
    const invalid = () =>
      new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
    if (!user || !user.passwordHash) {
      await verifyAgainstDummy(input.password);
      await audit(db, req, {
        action: 'auth.login',
        outcome: 'FAILURE',
        data: { reason: 'unknown_user' },
      });
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > now()) {
      await audit(db, req, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: 'auth.login',
        outcome: 'DENIED',
        data: { reason: 'locked' },
      });
      throw new AppError(429, 'ACCOUNT_LOCKED', 'accountLocked');
    }
    const ok = await verifySecret(input.password, user.passwordHash);
    if (!ok || user.status !== 'ACTIVE') {
      if (!ok) {
        const updated = await db.user.update({
          where: { id: user.id },
          data: { failedLoginCount: { increment: 1 } },
        });
        if (updated.failedLoginCount >= LOCK_THRESHOLD)
          await db.user.update({
            where: { id: user.id },
            data: {
              lockedUntil: new Date(now().getTime() + LOCK_MS),
              failedLoginCount: 0,
            },
          });
      }
      await audit(db, req, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: 'auth.login',
        outcome: 'FAILURE',
        data: { reason: ok ? 'disabled' : 'bad_password' },
      });
      throw invalid();
    }
    if (user.tenant.status !== 'ACTIVE')
      throw new AppError(403, 'TENANT_SUSPENDED', 'tenantSuspended');
    const mfaPending = user.mfaEnabledAt !== null;
    // Start in the first branch the user may work in; they can switch later.
    const defaultBranch =
      user.tenant.kind === 'BUSINESS'
        ? await db.branch.findFirst({
            where: {
              tenantId: user.tenantId,
              isActive: true,
              deletedAt: null,
              ...(user.allBranches
                ? {}
                : { users: { some: { userId: user.id } } }),
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        : null;
    const { token, maxAgeMs } = await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now() },
      });
      const created = await createSession(tx, services, {
        tenantId: user.tenantId,
        userId: user.id,
        authMethod: 'PASSWORD',
        mfaVerified: !mfaPending,
        branchId: defaultBranch?.id ?? null,
        deviceId: null,
        req,
      });
      await audit(tx, req, {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'session',
        entityId: created.session.id,
        data: { mfaPending },
      });
      return created;
    });
    setCookie(res, services, names.session, token, maxAgeMs);
    res.json({ mfaRequired: mfaPending });
  });

  router.post(
    '/auth/mfa/verify',
    credentialLimiter,
    requireAuth({ allowMfaPending: true, allowPasswordChange: true }),
    async (req, res) => {
      const auth = getAuth(res);
      const { code } = parse(z.object({ code: z.string().trim() }), req.body);
      if (auth.mfaVerified) {
        res.json({ ok: true });
        return;
      }
      const user = await db.user.findUniqueOrThrow({
        where: { id: auth.userId },
      });
      const step =
        user.mfaSecretEnc &&
        verifyTotp(
          services.secrets.decrypt(user.mfaSecretEnc),
          code,
          user.mfaLastStep,
          now().getTime(),
        );
      if (!step) {
        await audit(db, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.mfa.verify',
          outcome: 'FAILURE',
        });
        throw new AppError(401, 'MFA_INVALID', 'mfaInvalid');
      }
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { mfaLastStep: BigInt(step) },
        });
        await tx.session.update({
          where: { id: auth.sessionId },
          data: {
            mfaVerified: true,
            reauthAt: now(),
            idleExpiresAt: new Date(now().getTime() + 60 * 60_000),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.mfa.verify',
        });
      });
      res.json({ ok: true });
    },
  );

  router.post('/auth/logout', async (req, res) => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (auth) {
      await db.$transaction(async (tx) => {
        await tx.session.update({
          where: { id: auth.sessionId },
          data: { revokedAt: now(), revokeReason: 'logout' },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.logout',
        });
      });
    }
    clearCookie(res, services, names.session);
    res.status(204).end();
  });

  router.get(
    '/auth/me',
    requireAuth({
      allowMfaPending: true,
      allowPasswordChange: true,
      allowMfaSetup: true,
    }),
    async (_req, res) => {
      const auth = getAuth(res);
      const tenant = await db.tenant.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { name: true, slug: true },
      });
      const billing = await billingNotice(db, auth, now());
      res.json({ ...publicAuth(auth), tenant, billing });
    },
  );

  router.post(
    '/auth/reauth',
    credentialLimiter,
    requireAuth(),
    async (req, res) => {
      const auth = getAuth(res);
      if (auth.authMethod !== 'PASSWORD') throw errors.forbidden();
      const input = parse(
        z.object({
          password: z.string().min(1).max(128),
          code: z.string().trim().optional(),
        }),
        req.body,
      );
      const user = await db.user.findUniqueOrThrow({
        where: { id: auth.userId },
      });
      let step: number | null = null;
      let ok =
        !!user.passwordHash &&
        (await verifySecret(input.password, user.passwordHash));
      if (ok && user.mfaSecretEnc && user.mfaEnabledAt) {
        step = verifyTotp(
          services.secrets.decrypt(user.mfaSecretEnc),
          input.code ?? '',
          user.mfaLastStep,
          now().getTime(),
        );
        ok = step !== null;
      }
      if (!ok) {
        await audit(db, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.reauth',
          outcome: 'FAILURE',
        });
        throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
      }
      await db.$transaction(async (tx) => {
        if (step !== null)
          await tx.user.update({
            where: { id: user.id },
            data: { mfaLastStep: BigInt(step) },
          });
        await tx.session.update({
          where: { id: auth.sessionId },
          data: { reauthAt: now() },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.reauth',
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/auth/password',
    credentialLimiter,
    requireAuth({ allowPasswordChange: true, allowMfaSetup: true }),
    async (req, res) => {
      const auth = getAuth(res);
      if (auth.authMethod !== 'PASSWORD') throw errors.forbidden();
      const input = parse(
        z.object({
          currentPassword: z.string().min(1).max(128),
          newPassword: z.string(),
        }),
        req.body,
      );
      if (!passwordSchema.safeParse(input.newPassword).success)
        throw new AppError(400, 'WEAK_PASSWORD', 'weakPassword');
      const user = await db.user.findUniqueOrThrow({
        where: { id: auth.userId },
      });
      if (
        !user.passwordHash ||
        !(await verifySecret(input.currentPassword, user.passwordHash))
      )
        throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
      const passwordHash = await hashSecret(input.newPassword);
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            passwordChangedAt: now(),
            mustChangePassword: false,
          },
        });
        // Other sessions may have been opened with the old password.
        await tx.session.updateMany({
          where: {
            userId: user.id,
            revokedAt: null,
            id: { not: auth.sessionId },
          },
          data: { revokedAt: now(), revokeReason: 'password_changed' },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.password.change',
          entityType: 'user',
          entityId: user.id,
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/auth/mfa/setup',
    requireAuth({ allowMfaSetup: true }),
    async (req, res) => {
      const auth = getAuth(res);
      if (auth.authMethod !== 'PASSWORD' || auth.mfaEnabled)
        throw errors.forbidden();
      const secret = generateTotpSecret();
      await db.user.update({
        where: { id: auth.userId },
        data: {
          mfaSecretEnc: services.secrets.encrypt(secret),
          mfaEnabledAt: null,
        },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'auth.mfa.setup',
      });
      res.json({ secret, uri: otpauthUri(secret, auth.username, 'FAST FOOD') });
    },
  );

  router.post(
    '/auth/mfa/enable',
    credentialLimiter,
    requireAuth({ allowMfaSetup: true }),
    async (req, res) => {
      const auth = getAuth(res);
      const { code } = parse(z.object({ code: z.string().trim() }), req.body);
      const user = await db.user.findUniqueOrThrow({
        where: { id: auth.userId },
      });
      if (
        auth.authMethod !== 'PASSWORD' ||
        user.mfaEnabledAt ||
        !user.mfaSecretEnc
      )
        throw errors.forbidden();
      const step = verifyTotp(
        services.secrets.decrypt(user.mfaSecretEnc),
        code,
        null,
        now().getTime(),
      );
      if (step === null) throw new AppError(400, 'MFA_INVALID', 'mfaInvalid');
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { mfaEnabledAt: now(), mfaLastStep: BigInt(step) },
        });
        await tx.session.update({
          where: { id: auth.sessionId },
          data: { mfaVerified: true, reauthAt: now() },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.mfa.enable',
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/auth/mfa/disable',
    requireAuth(),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      if (auth.mfaPolicyRequired) throw errors.forbidden();
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: auth.userId },
          data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaLastStep: null },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'auth.mfa.disable',
        });
      });
      res.json({ ok: true });
    },
  );

  router.get('/auth/sessions', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    const sessions = await db.session.findMany({
      where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: now() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        authMethod: true,
        createdAt: true,
        lastSeenAt: true,
        userAgent: true,
        ipAddress: true,
        deviceId: true,
      },
    });
    res.json({
      sessions: sessions.map((session) => ({
        ...session,
        current: session.id === auth.sessionId,
      })),
    });
  });

  router.post('/auth/sessions/:id/revoke', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.session.updateMany({
      where: { id, userId: auth.userId, revokedAt: null },
      data: { revokedAt: now(), revokeReason: 'user_revoked' },
    });
    if (result.count === 0) throw errors.notFound();
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'auth.session.revoke',
      entityType: 'session',
      entityId: id,
    });
    res.json({ ok: true });
  });

  router.post('/auth/branch', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (auth.authMethod === 'PIN') throw errors.forbidden();
    const { branchId } = parse(z.object({ branchId: z.uuid() }), req.body);
    const branch = await db.branch.findFirst({
      where: {
        id: branchId,
        tenantId: auth.tenantId,
        deletedAt: null,
        isActive: true,
      },
    });
    if (!branch || !canAccessBranch(auth, branch.id)) throw errors.forbidden();
    await db.session.update({
      where: { id: auth.sessionId },
      data: { branchId },
    });
    res.json({ ok: true });
  });

  // --- Device-bound PIN authentication (POS terminals, kitchen screens) ---

  router.get('/pin/device', async (req, res) => {
    const device = await findDevice(services, req);
    if (!device) throw new AppError(403, 'DEVICE_REQUIRED', 'deviceRequired');
    const staff = await db.user.findMany({
      where: {
        tenantId: device.tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        pinHash: { not: null },
        OR: [
          { allBranches: true },
          { branches: { some: { branchId: device.branchId } } },
        ],
      },
      orderBy: { displayName: 'asc' },
      select: { id: true, displayName: true },
    });
    res.json({
      device: { id: device.id, name: device.name },
      tenant: { name: device.tenant.name },
      branch: { id: device.branch.id, name: device.branch.name },
      staff,
    });
  });

  router.post('/auth/pin', credentialLimiter, async (req, res) => {
    const device = await findDevice(services, req);
    if (!device) throw new AppError(403, 'DEVICE_REQUIRED', 'deviceRequired');
    const input = parse(
      z.object({ userId: z.uuid(), pin: z.string() }),
      req.body,
    );
    const user = await db.user.findFirst({
      where: {
        id: input.userId,
        tenantId: device.tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        OR: [
          { allBranches: true },
          { branches: { some: { branchId: device.branchId } } },
        ],
      },
    });
    const invalid = () => new AppError(401, 'INVALID_PIN', 'invalidPin');
    if (!user || !user.pinHash || !pinSchema.safeParse(input.pin).success) {
      await verifyAgainstDummy(input.pin);
      throw invalid();
    }
    if (user.pinLockedUntil && user.pinLockedUntil > now())
      throw new AppError(429, 'ACCOUNT_LOCKED', 'accountLocked');
    const ok = await verifySecret(
      services.secrets.pepperPin(user.id, input.pin),
      user.pinHash,
    );
    if (!ok) {
      const updated = await db.user.update({
        where: { id: user.id },
        data: { failedPinCount: { increment: 1 } },
      });
      if (updated.failedPinCount >= LOCK_THRESHOLD)
        await db.user.update({
          where: { id: user.id },
          data: {
            pinLockedUntil: new Date(now().getTime() + LOCK_MS),
            failedPinCount: 0,
          },
        });
      await audit(db, req, {
        tenantId: user.tenantId,
        branchId: device.branchId,
        actorUserId: user.id,
        action: 'auth.pin',
        outcome: 'FAILURE',
        data: { deviceId: device.id },
      });
      throw invalid();
    }
    const { token, maxAgeMs } = await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedPinCount: 0, pinLockedUntil: null, lastLoginAt: now() },
      });
      await tx.device.update({
        where: { id: device.id },
        data: { lastSeenAt: now() },
      });
      const created = await createSession(tx, services, {
        tenantId: user.tenantId,
        userId: user.id,
        authMethod: 'PIN',
        // PIN sessions never satisfy MFA for privileged remote work; see requireRecentAuth.
        mfaVerified: true,
        branchId: device.branchId,
        deviceId: device.id,
        req,
      });
      await audit(tx, req, {
        tenantId: user.tenantId,
        branchId: device.branchId,
        actorUserId: user.id,
        action: 'auth.pin',
        entityType: 'session',
        entityId: created.session.id,
        data: { deviceId: device.id },
      });
      return created;
    });
    setCookie(res, services, names.session, token, maxAgeMs);
    res.json({ ok: true });
  });

  return router;
}
