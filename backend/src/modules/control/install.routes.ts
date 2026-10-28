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
import { Prisma } from '../../generated/prisma/client.js';
import { catalogByKey } from './catalog.js';
import { resolveParams, sanitizeParams } from './policy.js';
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

  // The Owner asked to rename this Windows computer; the Admin decides here.
  router.get('/control/link/host-rename', ...manage, async (_req, res) => {
    const request = await services.controlRuntime?.hostRenameRequest();
    res.json({
      request: request?.status === 'REQUESTED' ? request : null,
      agent: services.hostRenameAgent === true,
    });
  });

  router.post('/control/link/host-rename', ...sensitive, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        id: z.uuid(),
        status: z.enum(['REJECTED', 'DONE', 'FAILED']),
        message: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    const done = await services.controlRuntime?.answerHostRename(input);
    if (!done) throw errors.conflict();
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: `control.hostname.${input.status.toLowerCase()}`,
      data: { message: input.message ?? null },
    });
    res.json({ ok: true });
  });

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
        const values: Record<string, Record<string, unknown>> = {};
        for (const [composite, params] of view.adminParams) {
          const [featureKey, role] = composite.split('|');
          if (featureKey === key && role) values[role] = params;
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
            params: def.params ?? [],
            values,
            // What SUPER_OWNER allows: delegated numbers never exceed it.
            ownerValues: resolveParams(view.policy, def, [], new Map()),
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
        enabled: z.boolean().nullable().optional(),
        params: z
          .record(
            z.string().max(40),
            z.union([z.number(), z.string().max(40), z.boolean()]),
          )
          .nullable()
          .optional(),
      }),
      req.body,
    );
    const view = await services.controlView?.(auth.tenantId);
    // Only features SUPER_OWNER delegated can be switched by the restaurant Admin.
    const def = catalogByKey.get(input.featureKey);
    if (!def || view?.policy.features[input.featureKey]?.mode !== 'ADMIN')
      throw errors.forbidden();
    const where = {
      tenantId_featureKey_roleKey: {
        tenantId: auth.tenantId,
        featureKey: input.featureKey,
        roleKey: input.roleKey,
      },
    };
    await db.$transaction(async (tx) => {
      const current = await tx.featureSetting.findUnique({ where });
      const enabled =
        input.enabled === undefined
          ? (current?.enabled ?? null)
          : input.enabled;
      const params =
        input.params === undefined
          ? ((current?.params as Prisma.InputJsonValue | null) ?? null)
          : input.params === null
            ? null
            : ((sanitizeParams(def, input.params, true) ??
                null) as Prisma.InputJsonValue | null);
      if (enabled === null && params === null)
        await tx.featureSetting.deleteMany({
          where: {
            tenantId: auth.tenantId,
            featureKey: input.featureKey,
            roleKey: input.roleKey,
          },
        });
      else
        await tx.featureSetting.upsert({
          where,
          create: {
            tenantId: auth.tenantId,
            featureKey: input.featureKey,
            roleKey: input.roleKey,
            enabled,
            params: params ?? Prisma.DbNull,
            updatedById: auth.userId,
          },
          update: {
            enabled,
            params: params ?? Prisma.DbNull,
            updatedById: auth.userId,
          },
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'feature.delegated.set',
        entityType: 'feature',
        entityId: input.featureKey,
        data: {
          roleKey: input.roleKey,
          enabled,
          params,
          before: {
            enabled: current?.enabled ?? null,
            params: current?.params ?? null,
          },
        },
      });
    });
    clearAdminSettingsCache();
    services.events?.publish({
      type: 'config.changed',
      tenantId: auth.tenantId,
    });
    res.json({ ok: true });
  });

  // --- Admin Menu Visibility (R06) -------------------------------------------
  router.get('/admin/menu-visibility', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    const row = await db.featureSetting.findUnique({
      where: {
        tenantId_featureKey_roleKey: {
          tenantId: auth.tenantId,
          featureKey: 'admin.menu_visibility',
          roleKey: '*',
        },
      },
    });
    const params = (row?.params as { hidden?: string[] }) ?? {};
    res.json({ hidden: Array.isArray(params.hidden) ? params.hidden : [] });
  });

  router.put('/admin/menu-visibility', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        hidden: z.array(z.string().trim().max(100)).max(50),
      }),
      req.body,
    );
    // Never allow hiding essential core menus: settings, dashboard, license
    const essential = new Set(['/', '/sozlamalar', '/litsenziya']);
    const sanitized = input.hidden.filter((path) => !essential.has(path));

    await db.featureSetting.upsert({
      where: {
        tenantId_featureKey_roleKey: {
          tenantId: auth.tenantId,
          featureKey: 'admin.menu_visibility',
          roleKey: '*',
        },
      },
      create: {
        tenantId: auth.tenantId,
        featureKey: 'admin.menu_visibility',
        roleKey: '*',
        params: { hidden: sanitized } as Prisma.InputJsonValue,
        updatedById: auth.userId,
      },
      update: {
        params: { hidden: sanitized } as Prisma.InputJsonValue,
        updatedById: auth.userId,
      },
    });

    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'admin.menu_visibility.set',
      entityType: 'setting',
      entityId: 'menu_visibility',
      data: { hidden: sanitized },
    });

    res.json({ ok: true, hidden: sanitized });
  });

  // Server migration: point this install at the new address of the same central server.
  router.put('/control/link/server', ...sensitive, async (req, res) => {
    const auth = getAuth(res);
    const { url } = parse(
      z.object({ url: z.string().trim().url().max(300) }),
      req.body,
    );
    const runtime = services.controlRuntime;
    if (!runtime) throw errors.notFound();
    const adopted = await runtime.relocate(url);
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'control.server.change',
      entityType: 'control_link',
      data: { url, adopted },
    });
    if (!adopted)
      throw new AppError(409, 'SERVER_UNREACHABLE', 'serverUnreachable');
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
