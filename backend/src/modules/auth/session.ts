import type { NextFunction, Request, Response } from 'express';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import type { AuthMethod } from '../../generated/prisma/client.js';
import { AppError, errors } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { featureCatalog } from '../control/catalog.js';
import { buildOrdering, type OrderingConfig } from '../control/ordering.js';
import {
  evaluateFeature,
  evaluateKey,
  financialVisibility,
  isCashierClass,
  type FinancialVisibility,
} from '../control/policy.js';
import { unlinkedView } from '../control/view.js';
import {
  entitlementsOf,
  entitlementsOverride,
  type Entitlements,
} from '../billing/entitlements.js';
import {
  allPermissions,
  isPermission,
  privilegedPermissions,
  type Permission,
  isDenied,
} from './permissions.js';

const MINUTE = 60_000;
export const sessionPolicy = {
  PASSWORD: { idleMs: 60 * MINUTE, absoluteMs: 12 * 60 * MINUTE },
  PIN: { idleMs: 30 * MINUTE, absoluteMs: 14 * 60 * MINUTE },
  // A PIN session on a registered kitchen screen or TV display: one PIN, then the
  // screen opens by itself every day (still bound to that device and its cookie).
  KIOSK: { idleMs: 7 * 24 * 60 * MINUTE, absoluteMs: 30 * 24 * 60 * MINUTE },
  mfaPendingMs: 10 * MINUTE,
  reauthWindowMs: 5 * MINUTE,
} as const;

/** Device panels whose PIN sessions follow the KIOSK policy. */
export const kioskPanels = new Set(['KITCHEN', 'DISPLAY']);
const policyOf = (authMethod: AuthMethod, panel?: string | null) =>
  authMethod === 'PIN' && panel && kioskPanels.has(panel)
    ? sessionPolicy.KIOSK
    : sessionPolicy[authMethod];

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
  // Plan features and limits; enforced server-side for business tenants.
  entitlements: Entitlements;
  // Cost price / margin / net profit visibility decided by SUPER_OWNER's policy;
  // Cashier-class users see none of them unless explicitly enabled.
  financial: FinancialVisibility;
  // Report columns SUPER_OWNER switched on or off for the whole restaurant.
  reportFields: { cost: boolean; margin: boolean; netProfit: boolean };
  // Order types, discount limits, display modes, TV and waiter alert settings.
  ordering: OrderingConfig;
  // Central control state: online, offline (grant), expired or blocked.
  control: {
    mode: string;
    reason: string | null;
    offlineUntil: Date | null;
  };
};

export function cookieNames(secure: boolean) {
  return secure
    ? { session: '__Host-ff_session', device: '__Host-ff_device' }
    : { session: 'ff_session', device: 'ff_device' };
}

export function readCookie(req: Request, name: string): string | undefined {
  return parseCookie(req.headers.cookie, name);
}

export function parseCookie(
  header: string | undefined,
  name: string,
): string | undefined {
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
    // Panel of that device (kitchen screens and TV displays stay signed in longer).
    devicePanel?: string | null;
    req: Request;
  },
) {
  const now = services.now?.() ?? new Date();
  const policy = policyOf(input.authMethod, input.devicePanel);
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

export type Authentication =
  | { status: 'none' | 'invalid' | 'suspended' }
  | { status: 'ok'; auth: AuthContext };

/**
 * Resolves session and device cookies into an AuthContext. Shared by HTTP requests
 * and WebSocket handshakes so both apply identical checks. Never trusts client claims.
 */
export async function authenticate(
  services: Services,
  cookieHeader: string | undefined,
  options: { touch: boolean } = { touch: true },
): Promise<Authentication> {
  const names = cookieNames(services.secureCookies);
  const token = parseCookie(cookieHeader, names.session);
  if (!token) return { status: 'none' };
  const deviceToken = parseCookie(cookieHeader, names.device);
  const now = services.now?.() ?? new Date();
  const session = await services.db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      tenant: { include: { subscription: { include: { plan: true } } } },
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
        deviceToken !== undefined &&
        sha256(deviceToken) === session.device.tokenHash));
  if (!valid) return { status: 'invalid' };
  if (session.tenant.status !== 'ACTIVE') return { status: 'suspended' };
  const permissions = new Set<Permission>();
  for (const { role } of user.roles) {
    // Owners always hold the full catalog, including permissions added after seeding.
    if (role.systemKey === 'owner')
      for (const key of allPermissions) permissions.add(key);
    for (const key of role.permissions)
      if (isPermission(key)) permissions.add(key);
  }
  // Vendor-level switches win over roles (SUPER_OWNER control).
  for (const key of [...permissions])
    if (isDenied(key)) permissions.delete(key);
  // SUPER_OWNER feature switches and financial visibility (backend-enforced).
  const roleKeys = user.roles.map(({ role }) => role.systemKey ?? role.id);
  const view = services.controlView
    ? await services.controlView(session.tenantId)
    : unlinkedView();
  for (const def of featureCatalog) {
    if (!def.permission || !permissions.has(def.permission)) continue;
    const evaluation = evaluateFeature(
      view.policy,
      def,
      roleKeys,
      view.adminSettings,
    );
    if (!(view.mode === 'OFFLINE' ? evaluation.offline : evaluation.online))
      permissions.delete(def.permission);
  }
  const hasPos = permissions.has('pos.access');
  const financial = financialVisibility(
    view.policy,
    roleKeys,
    hasPos,
    view.adminSettings,
  );
  if (!financial.cost) permissions.delete('menu.cost.view');
  if (
    isCashierClass(roleKeys, hasPos) &&
    !(financial.margin || financial.profit)
  )
    permissions.delete('finance.view');
  const fieldOn = (key: string) =>
    evaluateKey(view.policy, key, roleKeys, view.adminSettings)?.online ?? true;
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
    isPlatformAdmin: user.isPlatformAdmin && session.tenant.kind === 'PLATFORM',
    authMethod: session.authMethod,
    permissions,
    roleKeys,
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
    entitlements: entitlementsOverride()
      ? await entitlementsOverride()!()
      : entitlementsOf(session.tenant.subscription),
    financial,
    reportFields: {
      cost: fieldOn('field.report.cost'),
      margin: fieldOn('field.report.margin'),
      netProfit: fieldOn('field.report.netProfit'),
    },
    ordering: buildOrdering({
      policy: view.policy,
      adminSettings: view.adminSettings,
      adminParams: view.adminParams,
      roleKeys,
      offline: view.mode === 'OFFLINE',
    }),
    control: {
      mode: view.mode,
      reason: view.reason,
      offlineUntil: view.offlineUntil,
    },
  };
  // Sliding idle expiry; written at most once a minute to limit database load.
  if (
    options.touch &&
    session.mfaVerified &&
    now.getTime() - session.lastSeenAt.getTime() > MINUTE
  ) {
    await services.db.session.update({
      where: { id: session.id },
      data: {
        lastSeenAt: now,
        idleExpiresAt: new Date(
          now.getTime() +
            policyOf(session.authMethod, session.device?.panel).idleMs,
        ),
      },
    });
  }
  return { status: 'ok', auth };
}

export function loadSession(services: Services) {
  const names = cookieNames(services.secureCookies);
  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await authenticate(services, req.headers.cookie);
    if (result.status === 'invalid') clearCookie(res, services, names.session);
    if (result.status === 'suspended') res.locals.tenantSuspended = true;
    if (result.status === 'ok') res.locals.auth = result.auth;
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

export function requireAnyPermission(...required: Permission[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    if (
      auth.tenantKind !== 'BUSINESS' ||
      !required.some((key) => auth.permissions.has(key))
    )
      throw errors.forbidden();
    next();
  };
}

/** Money visibility gate: cost, margin or net profit must be visible to the caller. */
export function requireFinancial(kind: keyof FinancialVisibility) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const auth = getAuth(res);
    const reportOff = kind === 'profit' && !auth.reportFields.netProfit;
    if (!auth.financial[kind] || reportOff) throw errors.forbidden();
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
