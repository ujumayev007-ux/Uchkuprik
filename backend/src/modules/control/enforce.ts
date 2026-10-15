import type { NextFunction, Request, Response } from 'express';
import type { Services } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { cookieNames, parseCookie, type AuthContext } from '../auth/session.js';
import { catalogByKey, matchRoute } from './catalog.js';
import { evaluateFeature } from './policy.js';
import { enqueueOperation } from './outbox.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Features that create or change orders: offline they are allowed from the Cashier
// panel only (kitchen devices keep updating tickets; nobody else adds orders).
const CASHIER_ONLY_OFFLINE = new Set([
  'orders.create',
  'orders.edit',
  'orders.table.assign',
]);

export function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/**
 * The Cashier panel is the cashier computer's own window or a terminal registered
 * for the CASHIER panel, used by a signed-in user who holds the POS permission.
 */
async function isCashierPanel(
  services: Services,
  req: Request,
  auth: AuthContext | undefined,
): Promise<boolean> {
  if (req.get('x-panel') !== 'cashier') return false;
  if (!auth || !auth.permissions.has('pos.access')) return false;
  if (isLoopback(req)) return true;
  const token = parseCookie(
    req.headers.cookie,
    cookieNames(services.secureCookies).device,
  );
  if (!token) return false;
  const device = await services.db.device.findUnique({
    where: { tokenHash: sha256(token) },
    select: { status: true, panel: true },
  });
  return device?.status === 'ACTIVE' && device.panel === 'CASHIER';
}

async function hasRegisteredDevice(
  services: Services,
  req: Request,
): Promise<boolean> {
  const token = parseCookie(
    req.headers.cookie,
    cookieNames(services.secureCookies).device,
  );
  if (!token) return false;
  const device = await services.db.device.findUnique({
    where: { tokenHash: sha256(token) },
    select: { status: true },
  });
  return device?.status === 'ACTIVE';
}

/**
 * Server-side enforcement of SUPER_OWNER's decisions on every API request:
 * feature switches, separate online/offline permissions, offline grant expiry,
 * online-only mode, blocked devices, Cashier-only offline orders and the minimum
 * version. The UI mirrors this; it is never the only guard.
 */
export function enforceControl(services: Services) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!services.controlView) return next();
    const match = matchRoute(req.method, req.path);
    if (match.kind === 'open') return next();
    const auth = res.locals.auth as AuthContext | undefined;
    // Cloud edition: the tenant is known only for signed-in requests.
    if (!services.selfHosted && !auth) return next();
    const view = await services.controlView(auth?.tenantId ?? null);
    const hasOverrides = Object.keys(view.policy.features).length > 0;
    if (view.mode === 'UNLINKED' && !hasOverrides) return next();
    const mutating = !SAFE_METHODS.has(req.method.toUpperCase());

    if (view.mode === 'BLOCKED')
      throw new AppError(403, 'DEVICE_BLOCKED', 'deviceBlocked');

    if (view.mode === 'EXPIRED' && mutating) {
      if (view.reason === 'CLOCK')
        throw new AppError(403, 'CLOCK_ROLLBACK', 'clockRollback');
      if (view.reason === 'OFFLINE_DISABLED' || view.reason === 'INVALID_GRANT')
        throw new AppError(503, 'ONLINE_REQUIRED', 'onlineRequired');
      throw new AppError(403, 'OFFLINE_EXPIRED', 'offlineExpired');
    }

    if (match.kind === 'unmapped') {
      // Fail closed offline: an endpoint nobody classified is not authorized there.
      if (view.mode === 'OFFLINE' && mutating)
        throw new AppError(403, 'OFFLINE_NOT_ALLOWED', 'offlineNotAllowed');
      return next();
    }

    const def = catalogByKey.get(match.key);
    if (!def) return next();
    const evaluation = evaluateFeature(
      view.policy,
      def,
      auth?.roleKeys ?? [],
      view.adminSettings,
    );

    if (view.mode === 'OFFLINE') {
      // Local terminals must be registered devices while the internet is down.
      if (!isLoopback(req) && !(await hasRegisteredDevice(services, req)))
        throw new AppError(403, 'LOCAL_DEVICE_REQUIRED', 'localDeviceRequired');
      if (!evaluation.offline)
        throw new AppError(403, 'OFFLINE_NOT_ALLOWED', 'offlineNotAllowed');
      if (
        mutating &&
        CASHIER_ONLY_OFFLINE.has(def.key) &&
        !(await isCashierPanel(services, req, auth))
      )
        throw new AppError(403, 'CASHIER_PANEL_ONLY', 'cashierPanelOnly');
      // Offline actions are queued for the centre; the record is written before the
      // response ends and is flagged for the Owner.
      if (mutating && services.controlRuntime)
        res.on('finish', () => {
          if (res.statusCode >= 400) return;
          void enqueueOperation(services.db, {
            type: 'offline_event',
            data: {
              feature: def.key,
              at: (services.now?.() ?? new Date()).toISOString(),
              user: auth?.username ?? null,
              method: req.method,
            },
          }).catch(() => undefined);
        });
      return next();
    }

    if (!evaluation.online)
      throw new AppError(403, 'FEATURE_DISABLED', 'featureDisabled');
    // An outdated install stops taking NEW orders once the grace moment passed;
    // payments, kitchen work and reads continue so a running sale is never cut off.
    if (view.versionBlocked && def.key === 'orders.create' && mutating)
      throw new AppError(426, 'UPDATE_REQUIRED', 'updateRequired');
    next();
  };
}
