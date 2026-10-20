import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { parseCookie } from '../auth/session.js';

// Owner (SUPER_OWNER) accounts live in their own tables and cookie: a restaurant
// session can never reach the control API and an owner session never reaches a
// restaurant's data through the tenant API.

const MINUTE = 60_000;
export const ownerPolicy = {
  idleMs: 30 * MINUTE,
  absoluteMs: 8 * 60 * MINUTE,
  mfaPendingMs: 10 * MINUTE,
  reauthWindowMs: 5 * MINUTE,
  // An Owner application that asked to stay signed in until the computer restarts:
  // the application itself ends the session on the next boot / shutdown.
  keptIdleMs: 12 * 60 * MINUTE,
  keptAbsoluteMs: 7 * 24 * 60 * MINUTE,
  challengeMs: 2 * MINUTE,
  lockThreshold: 5,
  lockMs: 15 * MINUTE,
} as const;

export const ownerCookieName = (secure: boolean) =>
  secure ? '__Host-ff_owner' : 'ff_owner';

export type OwnerContext = {
  sessionId: string;
  ownerId: string;
  email: string;
  displayName: string;
  deviceId: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  reauthAt: Date | null;
};

const now = (services: Services) => services.now?.() ?? new Date();

/** Stateless login challenge: HMAC-bound timestamp + nonce, valid for two minutes. */
export function issueChallenge(services: Services): string {
  const body = `${now(services).getTime()}.${randomToken(16)}`;
  const mac = createHmac(
    'sha256',
    services.secrets.keyedHash('owner-challenge', 'k'),
  )
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function checkChallenge(services: Services, challenge: string): boolean {
  const parts = challenge.split('.');
  if (parts.length !== 3) return false;
  const [stamp, nonce, mac] = parts as [string, string, string];
  const expected = createHmac(
    'sha256',
    services.secrets.keyedHash('owner-challenge', 'k'),
  )
    .update(`${stamp}.${nonce}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const age = now(services).getTime() - Number(stamp);
  return age >= 0 && age <= ownerPolicy.challengeMs;
}

export async function createOwnerSession(
  tx: Tx,
  services: Services,
  input: {
    ownerId: string;
    deviceId: string;
    mfaVerified: boolean;
    req: Request;
    keep?: boolean;
    // False for a sign-in from a trusted computer without a code: sensitive actions
    // then still ask for a fresh password + code.
    codeVerified?: boolean;
  },
) {
  const at = now(services);
  const kept = input.keep === true && input.mfaVerified;
  const token = randomToken();
  const session = await tx.controlOwnerSession.create({
    data: {
      tokenHash: sha256(token),
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      mfaVerified: input.mfaVerified,
      reauthAt: input.mfaVerified && input.codeVerified !== false ? at : null,
      idleExpiresAt: new Date(
        at.getTime() +
          (input.mfaVerified
            ? kept
              ? ownerPolicy.keptIdleMs
              : ownerPolicy.idleMs
            : ownerPolicy.mfaPendingMs),
      ),
      expiresAt: new Date(
        at.getTime() +
          (kept ? ownerPolicy.keptAbsoluteMs : ownerPolicy.absoluteMs),
      ),
      ipAddress: input.req.ip ?? null,
      userAgent: input.req.get('user-agent')?.slice(0, 200) ?? null,
    },
  });
  return { token, session };
}

/** Resolves the owner cookie; the device must still be approved on every request. */
export function loadOwner(services: Services) {
  const name = ownerCookieName(services.secureCookies);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = parseCookie(req.headers.cookie, name);
    if (!token) return next();
    const at = now(services);
    const session = await services.db.controlOwnerSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { owner: true, device: true },
    });
    const valid =
      session &&
      !session.revokedAt &&
      session.expiresAt > at &&
      session.idleExpiresAt > at &&
      session.owner.status === 'ACTIVE' &&
      session.device.status === 'APPROVED';
    if (!valid) {
      res.clearCookie(name, {
        httpOnly: true,
        secure: services.secureCookies,
        sameSite: 'strict',
        path: '/',
      });
      return next();
    }
    res.locals.owner = {
      sessionId: session.id,
      ownerId: session.ownerId,
      email: session.owner.email,
      displayName: session.owner.displayName,
      deviceId: session.deviceId,
      mfaEnabled: session.owner.mfaEnabledAt !== null,
      mfaVerified: session.mfaVerified,
      reauthAt: session.reauthAt,
    } satisfies OwnerContext;
    if (
      session.mfaVerified &&
      at.getTime() - session.lastSeenAt.getTime() > MINUTE
    )
      await services.db.controlOwnerSession.update({
        where: { id: session.id },
        data: {
          lastSeenAt: at,
          // A "stay signed in until restart" session keeps its longer idle window.
          idleExpiresAt: new Date(
            at.getTime() +
              (session.expiresAt.getTime() - session.createdAt.getTime() >
              ownerPolicy.absoluteMs + MINUTE
                ? ownerPolicy.keptIdleMs
                : ownerPolicy.idleMs),
          ),
        },
      });
    next();
  };
}

export function getOwner(res: Response): OwnerContext {
  const owner = res.locals.owner as OwnerContext | undefined;
  if (!owner) throw errors.unauthenticated();
  return owner;
}

/** Fully authenticated owner (second factor done). */
export function requireOwner(options: { allowMfaSetup?: boolean } = {}) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const owner = getOwner(res);
    if (!owner.mfaVerified && !options.allowMfaSetup)
      throw new AppError(401, 'MFA_REQUIRED', 'mfaRequired');
    next();
  };
}

/** Sensitive actions need a password+code confirmation within the last minutes. */
export function requireOwnerReauth(services: Services) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const owner = getOwner(res);
    if (
      !owner.reauthAt ||
      now(services).getTime() - owner.reauthAt.getTime() >
        ownerPolicy.reauthWindowMs
    )
      throw new AppError(403, 'REAUTH_REQUIRED', 'reauthRequired');
    next();
  };
}

export type ControlAuditEntry = {
  ownerId?: string | null;
  customerId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  // Never include secrets, plaintext licence keys, hashes or tokens.
  data?: Prisma.InputJsonValue;
};

/** Append-only evidence; written in the caller's transaction when given one. */
export async function controlAudit(
  db: Db | Tx,
  req: Request | null,
  entry: ControlAuditEntry,
) {
  await db.controlAuditLog.create({
    data: {
      ownerId: entry.ownerId ?? null,
      customerId: entry.customerId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ipAddress: req?.ip ?? null,
      requestId: (req?.res?.locals.requestId as string | undefined) ?? null,
    },
  });
}
