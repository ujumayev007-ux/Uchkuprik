import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth } from '../auth/session.js';
import {
  clearLicenseCache,
  licenseAllowsUse,
  licenseStatus,
  syncLicense,
  verifyLicense,
} from './license.js';

// Paths that keep working without a valid licence (sign-in and entering a key).
const open = [
  /^\/health\//,
  /^\/auth\//,
  /^\/license/,
  /^\/public\/(plans|register)$/,
  /^\/devices\/heartbeat$/,
  // Recovery: the restaurant can still take its own data out after the licence ended.
  /^\/reports\/(export|preview|layout)$/,
  /^\/tenant\/export/,
];

/** Self-hosted installs stop working (data kept) when the licence has expired. */
export function enforceLicense(services: Services) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!services.selfHosted || open.some((pattern) => pattern.test(req.path)))
      return next();
    const status = await licenseStatus(services);
    if (!licenseAllowsUse(status))
      return next(new AppError(402, 'LICENSE_EXPIRED', 'licenseExpired'));
    next();
  };
}

export function licenseRouter(services: Services) {
  const router = Router();

  router.get('/license', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    if (!services.selfHosted) {
      res.json({ selfHosted: false });
      return;
    }
    res.json({ selfHosted: true, ...(await licenseStatus(services)) });
  });

  // Fetches the vendor's latest renewals/blocking now (e.g. right after paying).
  router.post('/license/sync', requireAuth(), async (_req, res) => {
    if (!services.selfHosted) throw errors.notFound();
    const result = await syncLicense(services);
    res.json({ result, ...(await licenseStatus(services)) });
  });

  // Only the business owner enters licence keys received from the vendor.
  router.post('/license', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (!services.selfHosted) throw errors.notFound();
    if (!auth.roleKeys.includes('owner')) throw errors.forbidden();
    const { key } = parse(
      z.object({ key: z.string().trim().min(20).max(5000) }),
      req.body,
    );
    const payload = verifyLicense(key);
    if (!payload || payload.installId !== services.installId)
      throw new AppError(400, 'LICENSE_INVALID', 'licenseInvalid');
    await services.db.appLicense.upsert({
      where: { id: 1 },
      update: { key },
      create: { id: 1, key },
    });
    clearLicenseCache();
    await audit(services.db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'license.update',
      data: { customer: payload.customer, expiresAt: payload.expiresAt },
    });
    res.json(await licenseStatus(services));
  });

  return router;
}
