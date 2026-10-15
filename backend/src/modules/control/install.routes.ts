import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import { catalogByKey } from './catalog.js';
import { isLoopback } from './enforce.js';
import { listOutbox, retryOperation } from './outbox.js';
import { clearAdminSettingsCache } from './view.js';

/**
 * Restaurant-side control endpoints: link status for the banner, activation with a
 * licence key, delegated feature switches and the synchronisation queue. Activation
 * never grants access to anything: employees sign in separately.
 */
export function controlInstallRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('settings.manage')];
  const sensitive = [...manage, requireRecentAuth(services)];

  router.get('/control/link/status', requireAuth(), async (_req, res) => {
    const runtime = services.controlRuntime;
    if (!runtime) {
      res.json({ linked: false, mode: 'UNLINKED', available: false });
      return;
    }
    res.json({ available: true, ...(await runtime.status()) });
  });

  // Read by the desktop launcher on this computer only (no sign-in involved).
  router.get('/control/link/update-info', async (req, res) => {
    if (!isLoopback(req) || !services.controlRuntime) throw errors.forbidden();
    res.json(await services.controlRuntime.updateInfo());
  });

  router.post('/control/link/activate', ...sensitive, async (req, res) => {
    const runtime = services.controlRuntime;
    if (!runtime) throw errors.notFound();
    const auth = getAuth(res);
    const input = parse(
      z.object({
        licenseKey: z.string().trim().min(10).max(60),
        deviceName: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .default('Kassa kompyuteri'),
        serverUrl: z.string().url().max(300).optional(),
      }),
      req.body,
    );
    let result;
    try {
      result = await runtime.activate({
        licenseKey: input.licenseKey,
        deviceName: input.deviceName,
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
      });
    } catch {
      throw new AppError(502, 'CONTROL_UNREACHABLE', 'unavailable');
    }
    if (!result.ok) {
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'control.activate.failed',
        outcome: 'DENIED',
      });
      const code = String(result.code ?? 'ACTIVATION_FAILED');
      throw new AppError(
        result.status === 409 ? 409 : 400,
        code,
        code === 'ACTIVATION_LIMIT' ? 'activationLimit' : 'licenseKeyInvalid',
      );
    }
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'control.activate',
      data: { customer: result.customerName },
    });
    await runtime.beat();
    res.status(201).json(await runtime.status());
  });

  router.post('/control/link/refresh', ...manage, async (_req, res) => {
    const runtime = services.controlRuntime;
    if (!runtime) throw errors.notFound();
    const beat = await runtime.beat();
    if (beat === 'ok') await runtime.sync().catch(() => undefined);
    res.json({ beat, ...(await runtime.status()) });
  });

  // ---- delegated features ---------------------------------------------------

  router.get('/control/link/features', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const view = await services.controlView?.(auth.tenantId);
    if (!view) {
      res.json({ features: [] });
      return;
    }
    const roles = await db.role.findMany({
      where: { tenantId: auth.tenantId },
      select: { systemKey: true, name: true },
    });
    const features = Object.entries(view.policy.features)
      .filter(([, value]) => value.mode === 'ADMIN')
      .flatMap(([key]) => {
        const def = catalogByKey.get(key);
        if (!def) return [];
        const settings: Record<string, boolean> = {};
        for (const [composite, enabled] of view.adminSettings) {
          const [featureKey, role] = composite.split('|');
          if (featureKey === key && role) settings[role] = enabled;
        }
        return [
          {
            key,
            label: def.label,
            group: def.group,
            kind: def.kind,
            sensitive: !!def.sensitive,
            defaultEnabled: def.defaultMode !== 'OFF',
            settings,
          },
        ];
      });
    res.json({
      features,
      roles: roles
        .filter((role) => role.systemKey)
        .map((role) => ({ key: role.systemKey, name: role.name })),
    });
  });

  router.put('/control/link/features', ...sensitive, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        featureKey: z.string().min(2).max(60),
        roleKey: z
          .string()
          .regex(/^[a-z0-9_-]{1,40}$|^\*$/)
          .default('*'),
        enabled: z.boolean().nullable(),
      }),
      req.body,
    );
    const view = await services.controlView?.(auth.tenantId);
    // Only features SUPER_OWNER delegated can be switched by the restaurant Admin.
    if (
      !catalogByKey.has(input.featureKey) ||
      view?.policy.features[input.featureKey]?.mode !== 'ADMIN'
    )
      throw errors.forbidden();
    const key = {
      tenantId_featureKey_roleKey: {
        tenantId: auth.tenantId,
        featureKey: input.featureKey,
        roleKey: input.roleKey,
      },
    };
    await db.$transaction(async (tx) => {
      if (input.enabled === null)
        await tx.featureSetting.deleteMany({
          where: {
            tenantId: auth.tenantId,
            featureKey: input.featureKey,
            roleKey: input.roleKey,
          },
        });
      else
        await tx.featureSetting.upsert({
          where: key,
          create: {
            tenantId: auth.tenantId,
            featureKey: input.featureKey,
            roleKey: input.roleKey,
            enabled: input.enabled,
            updatedById: auth.userId,
          },
          update: { enabled: input.enabled, updatedById: auth.userId },
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'feature.delegated.set',
        entityType: 'feature',
        entityId: input.featureKey,
        data: { roleKey: input.roleKey, enabled: input.enabled },
      });
    });
    clearAdminSettingsCache();
    res.json({ ok: true });
  });

  // ---- synchronisation queue -------------------------------------------------

  router.get('/control/link/sync', ...manage, async (_req, res) => {
    const rows = await listOutbox(db, 100);
    res.json({
      operations: rows.map((row) => ({
        id: row.id,
        opId: row.opId,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt,
        nextAttemptAt: row.nextAttemptAt,
      })),
    });
  });

  router.post('/control/link/sync/:id/retry', ...manage, async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    if (!(await retryOperation(db, id))) throw errors.notFound();
    res.json({ ok: true });
  });

  return router;
}
