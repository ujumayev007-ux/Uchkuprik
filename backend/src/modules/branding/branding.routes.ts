import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { getAuth, requireAuth, requirePermission } from '../auth/session.js';
import {
  AD_PANELS,
  adsForPanel,
  clearBundleCache,
  resolveBranding,
  type AdPanel,
} from './bundle.js';
import {
  adminLayerSchema,
  layerOf,
  SKINS,
  SKIN_LABELS,
  type DesignLayer,
} from './design.js';
import { sendMedia, storeMedia } from './media.js';

/** Branding as the restaurant's own screens see it (sign-in design, panels, advertising). */
export function brandingRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const manage = [requireAuth(), requirePermission('settings.manage')];

  /** Tenant of a public request: the typed business code, else this install's own restaurant. */
  async function publicTenant(slug: unknown): Promise<string | null> {
    if (typeof slug === 'string' && slug.trim()) {
      const tenant = await db.tenant.findUnique({
        where: { slug: slug.trim().toLowerCase().slice(0, 40) },
        select: { id: true, kind: true },
      });
      return tenant?.kind === 'BUSINESS' ? tenant.id : null;
    }
    if (services.control?.plane) return null;
    const first = await db.tenant.findFirst({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return first?.id ?? null;
  }

  // Sign-in and splash design: public (the screen is shown before anybody signs in).
  router.get('/branding/login', limiter, async (req, res) => {
    const tenantId = await publicTenant(req.query.tenant);
    const { bundle, design } = await resolveBranding(services, tenantId);
    res.json({
      v: bundle.v,
      login: design.login,
      panels: design.panels,
      splash: design.splash,
      // Guest-facing pages (menu, order tracking) show the Customer-panel advertising.
      ...(req.query.ads === 'customer'
        ? {
            ads: adsForPanel(bundle.ads, 'CUSTOMER'),
            serverTime: (services.now?.() ?? new Date()).toISOString(),
          }
        : {}),
    });
  });

  router.get('/branding/media/:id', limiter, async (req, res) => {
    await sendMedia(db, parse(z.uuid(), req.params.id), res, req);
  });

  router.get('/branding', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    const panel = req.query.panel
      ? parse(z.enum(AD_PANELS), String(req.query.panel).toUpperCase())
      : null;
    const branding = await resolveBranding(
      services,
      auth.tenantId,
      auth.roleKeys,
    );
    res.json({
      v: branding.bundle.v,
      design: branding.design,
      delegated: branding.delegated,
      ads: adsForPanel(branding.bundle.ads, panel),
      serverTime: (services.now?.() ?? new Date()).toISOString(),
    });
  });

  // A screen reports that it showed or closed an advertisement (counters only).
  router.post('/branding/ads/:id/event', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { event, panel } = parse(
      z.object({
        event: z.enum(['shown', 'closed']),
        panel: z.enum(AD_PANELS),
      }),
      req.body,
    );
    const branding = await resolveBranding(services, auth.tenantId);
    if (
      !branding.customerId ||
      !branding.bundle.ads.some((ad) => ad.id === id)
    ) {
      res.status(204).end();
      return;
    }
    const at = services.now?.() ?? new Date();
    const day = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const key = {
      campaignId_customerId_day_panel: {
        campaignId: id,
        customerId: branding.customerId,
        day,
        panel,
      },
    };
    await db.adStat.upsert({
      where: key,
      create: {
        campaignId: id,
        customerId: branding.customerId,
        day,
        panel,
        shown: event === 'shown' ? 1 : 0,
        closed: event === 'closed' ? 1 : 0,
      },
      update:
        event === 'shown'
          ? { shown: { increment: 1 } }
          : { closed: { increment: 1 } },
    });
    res.status(204).end();
  });

  // ---- restaurant Admin design (only while the Owner delegated it) ---------------
  async function requireDelegated(auth: ReturnType<typeof getAuth>) {
    const branding = await resolveBranding(
      services,
      auth.tenantId,
      auth.roleKeys,
    );
    if (!branding.delegated)
      throw new AppError(403, 'FEATURE_DISABLED', 'featureDisabled');
    return branding;
  }

  router.get('/branding/admin', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const branding = await resolveBranding(
      services,
      auth.tenantId,
      auth.roleKeys,
    );
    const own = branding.delegated
      ? await db.tenantDesign.findUnique({ where: { tenantId: auth.tenantId } })
      : null;
    res.json({
      delegated: branding.delegated,
      skins: SKINS.map((key) => ({ key, ...SKIN_LABELS[key] })),
      // The design that applies now, and the restaurant's own layer on top of the Owner's.
      design: branding.design,
      layer: own ? layerOf(own.config) : null,
    });
  });

  router.put('/branding/admin', ...manage, async (req, res) => {
    const auth = getAuth(res);
    await requireDelegated(auth);
    const layer: DesignLayer = parse(adminLayerSchema, req.body);
    const ids = JSON.stringify(layer).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    );
    if (ids?.length) {
      const found = await db.brandingMedia.count({
        where: { id: { in: ids }, kind: 'IMAGE' },
      });
      if (found !== new Set(ids).size)
        throw new AppError(400, 'MEDIA_INVALID', 'mediaInvalid');
    }
    const before = await db.tenantDesign.findUnique({
      where: { tenantId: auth.tenantId },
    });
    await db.$transaction(async (tx) => {
      await tx.tenantDesign.upsert({
        where: { tenantId: auth.tenantId },
        create: {
          tenantId: auth.tenantId,
          config: layer as Prisma.InputJsonValue,
          updatedById: auth.userId,
        },
        update: {
          config: layer as Prisma.InputJsonValue,
          version: { increment: 1 },
          updatedById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'branding.design.admin',
        entityType: 'tenant_design',
        data: {
          from: (before?.config ?? null) as Prisma.InputJsonValue,
          to: layer as Prisma.InputJsonValue,
        },
      });
    });
    clearBundleCache();
    services.events?.publish({
      type: 'branding.changed',
      tenantId: auth.tenantId,
    });
    res.json({ ok: true });
  });

  router.delete('/branding/admin', ...manage, async (req, res) => {
    const auth = getAuth(res);
    await requireDelegated(auth);
    parse(z.object({ confirm: z.literal(true) }), req.body);
    await db.tenantDesign.deleteMany({ where: { tenantId: auth.tenantId } });
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'branding.design.admin.reset',
      entityType: 'tenant_design',
    });
    services.events?.publish({
      type: 'branding.changed',
      tenantId: auth.tenantId,
    });
    res.json({ ok: true });
  });

  router.post('/branding/admin/media', ...manage, async (req, res) => {
    const auth = getAuth(res);
    await requireDelegated(auth);
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0)
      throw errors.validation([{ path: 'file' }]);
    const name = typeof req.query.name === 'string' ? req.query.name : 'rasm';
    const media = await storeMedia(db, bytes, name, ['IMAGE']);
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'branding.media.admin.upload',
      entityType: 'branding_media',
      entityId: media.id,
    });
    res.status(201).json({ media });
  });

  return router;
}

export type { AdPanel };
