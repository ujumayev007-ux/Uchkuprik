import { Router } from 'express';
import type { Services } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import { attachSpoke, replicationStatus } from './engine.js';

/**
 * "Markaz bilan sinxronlash" for the Admin: the status (queue, last contact, conflicts)
 * on both servers, and, on the Kassa server, switching it on for this restaurant.
 */
export function replicationRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('settings.manage')];

  router.get('/replication/status', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const linked = services.controlRuntime
      ? (await services.controlRuntime.link()) !== null
      : false;
    res.json({
      ...(await replicationStatus(db, auth.tenantId)),
      canAttach: !!services.selfHosted && !services.control?.plane && linked,
    });
  });

  router.post(
    '/replication/attach',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      // Only a Kassa server linked to the central server (by its licence) can attach.
      if (!services.selfHosted || services.control?.plane)
        throw new AppError(409, 'NOT_A_KASSA_SERVER', 'conflict');
      if (!services.controlRuntime || !(await services.controlRuntime.link()))
        throw new AppError(409, 'NOT_LINKED', 'conflict');
      const result = await attachSpoke(db, services.secrets, auth.tenantId);
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'replication.attach',
        entityType: 'tenant',
        entityId: auth.tenantId,
        data: { queued: result.queued },
      });
      res.status(result.attached ? 201 : 200).json(result);
      // Start at once instead of waiting for the next round.
      if (result.attached)
        void services.controlRuntime.replicate().catch(() => undefined);
    },
  );

  return router;
}
