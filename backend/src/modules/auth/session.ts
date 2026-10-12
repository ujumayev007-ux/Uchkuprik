import type { NextFunction, Request, Response } from 'express';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import type { AuthMethod } from '../../generated/prisma/client.js';
import { AppError, errors } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import {
  isPermission,
  privilegedPermissions,
  type Permission,
} from './permissions.js';

const MINUTE = 60_000;
export const sessionPolicy = {
  PASSWORD: { idleMs: 60 * MINUTE, absoluteMs: 12 * 60 * MINUTE },
  PIN: { idleMs: 30 * MINUTE, absoluteMs: 14 * 60 * MINUTE },
  mfaPendingMs: 10 * MINUTE,
  reauthWindowMs: 5 * MINUTE,
} as const;

export type AuthContext = {
  sessionId: string;
  tenantId: string;
  tenantKind: 'PLATFORM' | 'BUSINESS';
  userId: string;
  username: string;
  displayName: string;
  isPlatformAdmin: boolean;
  authMethod: AuthMethod;
  permissions: Set<Permission>;
  roleKeys: string[];
  allBranches: boolean;
  branchIds: string[];
  activeBranchId: string | null;
  deviceId: string | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mfaPolicyRequired: boolean;
  mustChangePassword: boolean;
  reauthAt: Date | null;
};

export function cookieNames(secure: boolean) {
  return secure
    ? { session: '__Host-ff_session', device: '__Host-ff_device' }
    : { session: 'ff_session', device: 'ff_device' };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function setCookie(
  res: Response,
  services: Services,
  name: string,
  value: string,
  maxAgeMs: number,
) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: services.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function clearCookie(res: Response, services: Services, name: string) {
  res.clearCookie(name, {
    httpOnly: true,
    secure: services.secureCookies,
    sameSite: 'strict',
    path: '/',
  });
}

export async function createSession(
  tx: Tx,
  services: Services,
  input: {
    tenantId: string;
    userId: string;
    authMethod: AuthMethod;
    mfaVerified: boolean;
    branchId: string | null;
    deviceId: string | null;
    req: Request;
  },
) {
  const now = services.now?.() ?? new Date();
  const policy = sessionPolicy[input.authMethod];
  const token = randomToken();
  const idleMs = input.mfaVerified ? policy.idleMs : sessionPolicy.mfaPendingMs;
  const session = await tx.session.create({
    data: {
      tokenHash: sha256(token),
      tenantId: input.tenantId,
      userId: input.userId,
      authMethod: input.authMethod,
      mfaVerified: input.mfaVerified,
      // A fresh password login counts as recent authentication.
      reauthAt:
        input.authMethod === 'PASSWORD' && input.mfaVerified ? now : null,
      branchId: input.branchId,
      deviceId: input.deviceId,
      idleExpiresAt: new Date(now.getTime() + idleMs),
      expiresAt: new Date(now.getTime() + policy.absoluteMs),
      ipAddress: input.req.ip ?? null,
      userAgent: input.req.get('user-agent')?.slice(0, 200) ?? null,
    },
  });
  return { token, session, maxAgeMs: policy.absoluteMs };
}

/** Resolves the session cookie into an AuthContext. Never trusts client claims. */
export function loadSession(services: Services) {
  const names = cookieNames(services.secureCookies);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, names.session);
    if (!token) return next();
    const now = services.now?.() ?? new Date();
    const session = await services.db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: {
        tenant: true,
        user: {
          include: {
            roles: { include: { role: true } },
            branches: { select: { branchId: true } },
          },
        },
        device: true,
      },
    });
    const user = session?.user;
    const valid =
      session &&
      user &&
      !session.revokedAt &&
      session.expiresAt > now &&
      session.idleExpiresAt > now &&
      user.status === 'ACTIVE' &&
      !user.deletedAt &&
      (session.authMethod !== 'PIN' ||
        (session.device?.status === 'ACTIVE' &&
          readCookie(req, names.device) !== undefined &&
          sha256(readCookie(req, names.device)!) === session.device.tokenHash));
    if (!valid) {
      clearCookie(res, services, names.session);
      return next();
    }
    if (session.tenant.status !== 'ACTIVE') {
      res.locals.tenantSuspended = true;
      return next();
    }
    const permissions = new Set<Permission>();
    for (const { role } of user.roles)
      for (const key of role.permissions)
        if (isPermission(key)) permissions.add(key);
    const isPrivileged = privilegedPermissions.some((key) =>
      permissions.has(key),
    );
    const auth: AuthContext = {
      sessionId: session.id,
      tenantId: session.tenantId,
      tenantKind: session.tenant.kind,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      isPlatformAdmin:
        user.isPlatformAdmin && session.tenant.kind === 'PLATFORM',
      authMethod: session.authMethod,
      permissions,
      roleKeys: user.roles.map(({ role }) => role.systemKey ?? role.id),
      allBranches: user.allBranches,
      branchIds: user.branches.map(({ branchId }) => branchId),
      activeBranchId: session.branchId,
      deviceId: session.deviceId,
      mfaEnabled: user.mfaEnabledAt !== null,
      mfaVerified: session.mfaVerified,
      mfaPolicyRequired:
        session.authMethod === 'PASSWORD' &&
        (user.isPlatformAdmin ||
          (session.tenant.requireMfaForAdmins && isPrivileged)),
      mustChangePassword:
        session.authMethod === 'PASSWORD' && user.mustChangePassword,
      reauthAt: session.reauthAt,
    };
    res.locals.auth = auth;
    // Sliding idle expiry; written at most once a minute to limit database load.
    if (
      session.mfaVerified &&
      now.getTime() - session.lastSeenAt.getTime() > MINUTE
    ) {
      await services.db.session.update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          idleExpiresAt: new Date(
            now.getTime() + sessionPolicy[session.authMethod].idleMs,
          ),
        },
      });
    }
    next();
  };
}

type Requirement = {
  // Routes used to complete login (MFA, password change, logout) allow partial sessions.
  allowMfaPending?: boolean;
  allowPasswordChange?: boolean;
  allowMfaSetup?: boolean;
};

export function getAuth(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) throw errors.unauthenticated();
  return auth;
}

export function requireAuth(requirement: Requirement = {}) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.tenantSuspended)
      throw new AppError(403, 'TENANT_SUSPENDED', 'tenantSuspended');
    const auth = getAuth(res);
    if (!auth.mfaVerified && !requirement.allowMfaPending)
      throw new AppError(401, 'MFA_REQUIRED', 'mfaRequired');
    if (auth.mustChangePassword && !requirement.allowPasswordChange)
      throw new AppError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'passwordChangeRequired',
      );
    if (
      auth.mfaPolicyRequired &&
      !auth.mfaEnabled &&
      !requirement.allowMfaSetup
    )
      throw new AppError(403, 'MFA_SETUP_REQUIRED', 'mfaSetupRequired');
    next();
  };
}

export function requirePermission(...required: Permission[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    if (
      auth.tenantKind !== 'BUSINESS' ||
      !required.every((key) => auth.permissions.has(key))
    )
      throw errors.forbidden();
    next();
  };
}

export function requirePlatformAdmin() {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!getAuth(res).isPlatformAdmin) throw errors.forbidden();
    next();
  };
}

/** Step-up check: PIN sessions can never perform these operations. */
export function requireRecentAuth(services: Services) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    const now = (services.now?.() ?? new Date()).getTime();
    if (
      auth.authMethod !== 'PASSWORD' ||
      !auth.reauthAt ||
      now - auth.reauthAt.getTime() > sessionPolicy.reauthWindowMs
    )
      throw new AppError(403, 'REAUTH_REQUIRED', 'reauthRequired');
    next();
  };
}

export function canAccessBranch(auth: AuthContext, branchId: string): boolean {
  return auth.allBranches || auth.branchIds.includes(branchId);
}
