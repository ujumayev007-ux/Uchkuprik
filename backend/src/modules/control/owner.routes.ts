import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import {
  hashSecret,
  verifyAgainstDummy,
  verifySecret,
} from '../../lib/crypto.js';
import { verifyTotp } from '../../lib/totp.js';
import { messages } from '../../messages.js';
import { passwordSchema } from '../auth/auth.routes.js';
import { featureCatalog } from './catalog.js';
import { fingerprintOf, publicKeyOf, verifyValue } from './keys.js';
import {
  checkChallenge,
  controlAudit,
  createOwnerSession,
  getOwner,
  issueChallenge,
  loadOwner,
  ownerCookieName,
  ownerPolicy,
  requireOwner,
  requireOwnerReauth,
} from './owner.js';

const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{40,200}$/);

/** Owner authentication, sessions and approved-device management. */
export function ownerRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const cookie = ownerCookieName(services.secureCookies);
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: services.limits?.credentialsPerMinute ?? 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', message: messages.rateLimited },
  });
  const authed = [loadOwner(services), requireOwner()];
  const sensitive = [...authed, requireOwnerReauth(services)];

  // Public and secret-free. The two fingerprints let an operator confirm that a new
  // server holds the SAME signing key and APP_SECRET_KEY as the old one (a server
  // migration must keep both, otherwise licences and sealed secrets stop working).
  router.get('/control/info', (_req, res) => {
    const pem = services.control?.signingKeyPem;
    res.json({
      plane: true,
      ...(pem
        ? { signingKey: fingerprintOf(publicKeyOf(pem)).slice(0, 16) }
        : {}),
      secretCheck: services.secrets
        .keyedHash('migration-check', 'ok')
        .slice(0, 16),
    });
  });

  router.get(
    '/control/catalog',
    loadOwner(services),
    requireOwner(),
    (_req, res) => {
      res.json({ features: featureCatalog });
    },
  );

  router.post('/control/owner/challenge', limiter, (_req, res) => {
    res.json({ challenge: issueChallenge(services) });
  });

  // Login needs three things: the password, a fresh challenge signed by an approved
  // Owner device key and the current authenticator code.
  router.post('/control/owner/login', limiter, async (req, res) => {
    const input = parse(
      z.object({
        email: z.string().trim().toLowerCase().email().max(200),
        password: z.string().min(1).max(200),
        challenge: z.string().min(20).max(300),
        deviceKey: publicKeySchema,
        deviceSignature: z.string().min(40).max(200),
        deviceLabel: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .default('Owner qurilmasi'),
        code: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      }),
      req.body,
    );
    const at = now();
    const deny = async (action: string, ownerId: string | null) => {
      await controlAudit(db, req, {
        ownerId,
        action,
        outcome: 'DENIED',
        data: { email: input.email },
      });
    };
    if (
      !checkChallenge(services, input.challenge) ||
      !verifyValue(
        input.deviceKey,
        { challenge: input.challenge, email: input.email },
        input.deviceSignature,
      )
    ) {
      await deny('owner.login.bad_proof', null);
      throw new AppError(
        403,
        'DEVICE_PROOF_INVALID',
        'controlSignatureInvalid',
      );
    }
    const owner = await db.controlOwner.findUnique({
      where: { email: input.email },
    });
    if (!owner || owner.status !== 'ACTIVE') {
      await verifyAgainstDummy(input.password);
      await deny('owner.login.unknown', null);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
    }
    if (owner.lockedUntil && owner.lockedUntil > at) {
      await deny('owner.login.locked', owner.id);
      throw new AppError(429, 'ACCOUNT_LOCKED', 'accountLocked');
    }
    const fail = async (action: string) => {
      const failures = owner.failedLoginCount + 1;
      await db.controlOwner.update({
        where: { id: owner.id },
        data: {
          failedLoginCount: failures,
          lockedUntil:
            failures >= ownerPolicy.lockThreshold
              ? new Date(at.getTime() + ownerPolicy.lockMs)
              : null,
        },
      });
      await deny(action, owner.id);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
    };
    if (!(await verifySecret(input.password, owner.passwordHash)))
      return fail('owner.login.bad_password');
    if (!owner.mfaSecretEnc || !owner.mfaEnabledAt) {
      await deny('owner.login.mfa_missing', owner.id);
      throw new AppError(403, 'MFA_SETUP_REQUIRED', 'ownerMfaSetup');
    }
    // Device: known and approved, pending, or new (first one is trusted on first use
    // only together with a valid authenticator code).
    const fingerprint = fingerprintOf(input.deviceKey);
    let device = await db.controlOwnerDevice.findUnique({
      where: { fingerprint },
    });
    if (device && device.ownerId !== owner.id) {
      await deny('owner.login.foreign_device', owner.id);
      throw new AppError(403, 'DEVICE_NOT_APPROVED', 'ownerDeviceRequired');
    }
    if (device?.status === 'REVOKED') {
      await deny('owner.login.revoked_device', owner.id);
      throw new AppError(403, 'DEVICE_REVOKED', 'ownerDeviceRevoked');
    }
    const secret = services.secrets.decrypt(owner.mfaSecretEnc);
    const step = input.code
      ? verifyTotp(secret, input.code, owner.mfaLastStep, at.getTime())
      : null;
    if (!device) {
      const hasApproved = await db.controlOwnerDevice.count({
        where: { ownerId: owner.id, status: 'APPROVED' },
      });
      const trusted = hasApproved === 0 && step !== null;
      device = await db.controlOwnerDevice.create({
        data: {
          ownerId: owner.id,
          label: input.deviceLabel,
          publicKey: input.deviceKey,
          fingerprint,
          status: trusted ? 'APPROVED' : 'PENDING',
          approvedAt: trusted ? at : null,
        },
      });
      await controlAudit(db, req, {
        ownerId: owner.id,
        action: trusted ? 'owner.device.enrolled' : 'owner.device.pending',
        entityType: 'owner_device',
        entityId: device.id,
        outcome: trusted ? 'SUCCESS' : 'DENIED',
        data: { label: input.deviceLabel, fingerprint },
      });
    }
    if (device.status === 'PENDING')
      throw new AppError(403, 'DEVICE_PENDING', 'ownerDevicePending', {
        fingerprint,
      });
    if (!input.code) throw new AppError(401, 'MFA_REQUIRED', 'mfaRequired');
    if (step === null) return fail('owner.login.bad_code');
    const session = await db.$transaction(async (tx) => {
      await tx.controlOwner.update({
        where: { id: owner.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: at,
          mfaLastStep: BigInt(step),
        },
      });
      await tx.controlOwnerDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: at, lastIp: req.ip ?? null },
      });
      const created = await createOwnerSession(tx, services, {
        ownerId: owner.id,
        deviceId: device.id,
        mfaVerified: true,
        req,
      });
      await controlAudit(tx, req, {
        ownerId: owner.id,
        action: 'owner.login',
        entityType: 'owner_session',
        entityId: created.session.id,
      });
      return created;
    });
    res.cookie(cookie, session.token, {
      httpOnly: true,
      secure: services.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: ownerPolicy.absoluteMs,
    });
    res.json({ ok: true, displayName: owner.displayName });
  });

  router.post(
    '/control/owner/logout',
    loadOwner(services),
    async (req, res) => {
      const owner = res.locals.owner as { sessionId: string } | undefined;
      if (owner)
        await db.controlOwnerSession.updateMany({
          where: { id: owner.sessionId, revokedAt: null },
          data: { revokedAt: now(), revokeReason: 'logout' },
        });
      res.clearCookie(cookie, {
        httpOnly: true,
        secure: services.secureCookies,
        sameSite: 'strict',
        path: '/',
      });
      void req;
      res.json({ ok: true });
    },
  );

  router.get('/control/owner/me', loadOwner(services), (_req, res) => {
    const owner = res.locals.owner as ReturnType<typeof getOwner> | undefined;
    if (!owner) throw errors.unauthenticated();
    res.json({
      email: owner.email,
      displayName: owner.displayName,
      mfaVerified: owner.mfaVerified,
      reauthAt: owner.reauthAt,
    });
  });

  // Step-up: password and a fresh authenticator code unlock sensitive actions for
  // five minutes.
  router.post('/control/owner/reauth', limiter, ...authed, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(
      z.object({
        password: z.string().min(1).max(200),
        code: z.string().regex(/^\d{6}$/),
      }),
      req.body,
    );
    const row = await db.controlOwner.findUniqueOrThrow({
      where: { id: owner.ownerId },
    });
    const at = now();
    const step = row.mfaSecretEnc
      ? verifyTotp(
          services.secrets.decrypt(row.mfaSecretEnc),
          input.code,
          row.mfaLastStep,
          at.getTime(),
        )
      : null;
    if (
      !(await verifySecret(input.password, row.passwordHash)) ||
      step === null
    ) {
      await controlAudit(db, req, {
        ownerId: owner.ownerId,
        action: 'owner.reauth.failed',
        outcome: 'DENIED',
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
    }
    await db.$transaction([
      db.controlOwner.update({
        where: { id: owner.ownerId },
        data: { mfaLastStep: BigInt(step) },
      }),
      db.controlOwnerSession.update({
        where: { id: owner.sessionId },
        data: { reauthAt: at },
      }),
    ]);
    res.json({ ok: true });
  });

  router.post('/control/owner/password', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(
      z.object({ current: z.string().min(1), next: passwordSchema }),
      req.body,
    );
    const row = await db.controlOwner.findUniqueOrThrow({
      where: { id: owner.ownerId },
    });
    if (!(await verifySecret(input.current, row.passwordHash)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'invalidCredentials');
    await db.$transaction(async (tx) => {
      await tx.controlOwner.update({
        where: { id: owner.ownerId },
        data: { passwordHash: await hashSecret(input.next) },
      });
      // Every other session ends: a stolen session cannot outlive a password change.
      await tx.controlOwnerSession.updateMany({
        where: {
          ownerId: owner.ownerId,
          revokedAt: null,
          id: { not: owner.sessionId },
        },
        data: { revokedAt: now(), revokeReason: 'password_changed' },
      });
      await controlAudit(tx, req, {
        ownerId: owner.ownerId,
        action: 'owner.password.change',
      });
    });
    res.json({ ok: true });
  });

  router.get('/control/owner/sessions', ...authed, async (_req, res) => {
    const owner = getOwner(res);
    const sessions = await db.controlOwnerSession.findMany({
      where: {
        ownerId: owner.ownerId,
        revokedAt: null,
        expiresAt: { gt: now() },
      },
      orderBy: { createdAt: 'desc' },
      include: { device: { select: { label: true } } },
    });
    res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        current: session.id === owner.sessionId,
        device: session.device.label,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      })),
    });
  });

  router.post(
    '/control/owner/sessions/:id/revoke',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.controlOwnerSession.updateMany({
        where: { id, ownerId: owner.ownerId, revokedAt: null },
        data: { revokedAt: now(), revokeReason: 'revoked_by_owner' },
      });
      if (result.count === 0) throw errors.notFound();
      await controlAudit(db, req, {
        ownerId: owner.ownerId,
        action: 'owner.session.revoke',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  router.get('/control/owner/devices', ...authed, async (_req, res) => {
    const owner = getOwner(res);
    const devices = await db.controlOwnerDevice.findMany({
      where: { ownerId: owner.ownerId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      devices: devices.map((device) => ({
        id: device.id,
        label: device.label,
        fingerprint: device.fingerprint,
        status: device.status,
        current: device.id === owner.deviceId,
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
        lastIp: device.lastIp,
        createdAt: device.createdAt,
      })),
    });
  });

  router.post(
    '/control/owner/devices/:id/approve',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.controlOwnerDevice.updateMany({
        where: { id, ownerId: owner.ownerId, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          approvedAt: now(),
          approvedById: owner.ownerId,
        },
      });
      if (result.count === 0) throw errors.notFound();
      await controlAudit(db, req, {
        ownerId: owner.ownerId,
        action: 'owner.device.approve',
        entityType: 'owner_device',
        entityId: id,
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/control/owner/devices/:id/revoke',
    ...sensitive,
    async (req, res) => {
      const owner = getOwner(res);
      const id = parse(z.uuid(), req.params.id);
      if (id === owner.deviceId) throw errors.conflict();
      await db.$transaction(async (tx) => {
        const result = await tx.controlOwnerDevice.updateMany({
          where: { id, ownerId: owner.ownerId, status: { not: 'REVOKED' } },
          data: { status: 'REVOKED' },
        });
        if (result.count === 0) throw errors.notFound();
        await tx.controlOwnerSession.updateMany({
          where: { deviceId: id, revokedAt: null },
          data: { revokedAt: now(), revokeReason: 'device_revoked' },
        });
        await controlAudit(tx, req, {
          ownerId: owner.ownerId,
          action: 'owner.device.revoke',
          entityType: 'owner_device',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  return router;
}
