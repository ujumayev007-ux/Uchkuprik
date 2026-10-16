import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, errors, parse } from '../../http/errors.js';
import {
  controlAudit,
  getOwner,
  loadOwner,
  requireOwner,
  requireOwnerReauth,
} from '../control/owner.js';
import { AD_PANELS, clearBundleCache } from './bundle.js';
import {
  designLayerSchema,
  layerOf,
  SKINS,
  SKIN_LABELS,
  type DesignLayer,
} from './design.js';
import { storeMedia } from './media.js';

const idParam = (value: unknown) => parse(z.uuid(), value);
const iso = z.iso.datetime().nullable().optional();

const adBody = z
  .object({
    title: z.string().trim().min(1).max(80),
    kind: z.enum(['TEXT', 'IMAGE', 'VIDEO']),
    format: z.enum(['FULLSCREEN', 'POPUP', 'BANNER']),
    text: z.string().trim().max(500).nullable().optional(),
    mediaId: z.uuid().nullable().optional(),
    panels: z.array(z.enum(AD_PANELS)).min(1).max(5),
    targetMode: z.enum(['ALL', 'SELECTED']).default('ALL'),
    customerIds: z.array(z.uuid()).max(500).default([]),
    durationSec: z.number().int().min(3).max(120).default(10),
    closable: z.boolean().default(true),
    autoCloseSec: z.number().int().min(3).max(300).nullable().optional(),
    startsAt: iso,
    endsAt: iso,
    everyMinutes: z.number().int().min(0).max(1440).default(0),
    maxPerDay: z.number().int().min(1).max(1000).nullable().optional(),
    priority: z.number().int().min(0).max(100).default(0),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']).default('DRAFT'),
  })
  .superRefine((value, context) => {
    if (value.kind === 'TEXT' && !value.text)
      context.addIssue({ code: 'custom', path: ['text'], message: 'text' });
    if (value.kind !== 'TEXT' && !value.mediaId)
      context.addIssue({ code: 'custom', path: ['mediaId'], message: 'media' });
    if (value.targetMode === 'SELECTED' && value.customerIds.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['customerIds'],
        message: 'targets',
      });
    if (
      value.startsAt &&
      value.endsAt &&
      new Date(value.endsAt) <= new Date(value.startsAt)
    )
      context.addIssue({ code: 'custom', path: ['endsAt'], message: 'range' });
    // Fullscreen advertisements must be closable or end by themselves.
    if (value.format === 'FULLSCREEN' && !value.closable && !value.autoCloseSec)
      context.addIssue({
        code: 'custom',
        path: ['autoCloseSec'],
        message: 'autoclose',
      });
  });

/**
 * Owner-only management of advertising campaigns, uploaded media and the remote
 * design. Everything is audited; changes reach hosted restaurants at once (Socket.io)
 * and installed restaurants with their next signed heartbeat.
 */
export function brandingOwnerRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const authed = [loadOwner(services), requireOwner()];
  const sensitive = [...authed, requireOwnerReauth(services)];

  /** Tells open screens of the affected hosted restaurants to reload their branding. */
  async function notify(customerIds: string[] | 'all') {
    clearBundleCache();
    const customers = await db.controlCustomer.findMany({
      where: {
        tenantId: { not: null },
        ...(customerIds === 'all' ? {} : { id: { in: customerIds } }),
      },
      select: { tenantId: true },
    });
    for (const customer of customers)
      if (customer.tenantId)
        services.events?.publish({
          type: 'branding.changed',
          tenantId: customer.tenantId,
        });
  }

  const audit = (
    req: Parameters<typeof controlAudit>[1],
    ownerId: string,
    action: string,
    entityId?: string,
    data?: Record<string, unknown>,
    customerId?: string,
  ) =>
    controlAudit(db, req, {
      ownerId,
      action,
      entityType: 'branding',
      ...(entityId ? { entityId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(data ? { data: data as never } : {}),
    });

  // ---- media ---------------------------------------------------------------
  router.post('/control/media', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0)
      throw new AppError(400, 'MEDIA_INVALID', 'mediaInvalid');
    const name = typeof req.query.name === 'string' ? req.query.name : 'fayl';
    const media = await storeMedia(db, bytes, name);
    await audit(req, owner.ownerId, 'branding.media.upload', media.id, {
      kind: media.kind,
      size: media.sizeBytes,
    });
    res.status(201).json({ media });
  });

  router.get('/control/media', ...authed, async (_req, res) => {
    const rows = await db.brandingMedia.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        kind: true,
        mime: true,
        name: true,
        sizeBytes: true,
        createdAt: true,
      },
    });
    res.json({ media: rows });
  });

  router.delete('/control/media/:id', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const [campaign, designs] = await Promise.all([
      db.adCampaign.findFirst({ where: { mediaId: id }, select: { id: true } }),
      db.brandingDesign.findMany({ select: { config: true } }),
    ]);
    const designUses = designs.some((row) =>
      JSON.stringify(row.config).includes(id),
    );
    if (campaign || designUses)
      throw new AppError(409, 'MEDIA_IN_USE', 'mediaInUse');
    const deleted = await db.brandingMedia.deleteMany({ where: { id } });
    if (deleted.count === 0) throw errors.notFound();
    await audit(req, owner.ownerId, 'branding.media.delete', id);
    res.json({ ok: true });
  });

  // ---- advertisements ---------------------------------------------------------
  const adRow = (
    ad: Prisma.AdCampaignGetPayload<{ include: { targets: true } }>,
    totals?: { shown: number; closed: number; delivered: number },
  ) => ({
    id: ad.id,
    title: ad.title,
    kind: ad.kind,
    format: ad.format,
    text: ad.text,
    mediaId: ad.mediaId,
    panels: ad.panels,
    targetMode: ad.targetMode,
    customerIds: ad.targets.map((target) => target.customerId),
    durationSec: ad.durationSec,
    closable: ad.closable,
    autoCloseSec: ad.autoCloseSec,
    startsAt: ad.startsAt,
    endsAt: ad.endsAt,
    everyMinutes: ad.everyMinutes,
    maxPerDay: ad.maxPerDay,
    priority: ad.priority,
    status: ad.status,
    version: ad.version,
    createdAt: ad.createdAt,
    updatedAt: ad.updatedAt,
    ...(totals ? { stats: totals } : {}),
  });

  async function checkReferences(input: z.infer<typeof adBody>) {
    if (input.mediaId) {
      const media = await db.brandingMedia.findUnique({
        where: { id: input.mediaId },
        select: { kind: true },
      });
      if (!media || media.kind !== input.kind)
        throw new AppError(400, 'AD_INVALID', 'adInvalid');
    }
    if (input.targetMode === 'SELECTED') {
      const count = await db.controlCustomer.count({
        where: { id: { in: input.customerIds } },
      });
      if (count !== new Set(input.customerIds).size)
        throw new AppError(400, 'AD_INVALID', 'adInvalid');
    }
  }

  const dataOf = (input: z.infer<typeof adBody>) => ({
    title: input.title,
    kind: input.kind,
    format: input.format,
    text: input.kind === 'TEXT' || input.text ? (input.text ?? null) : null,
    mediaId: input.kind === 'TEXT' ? null : (input.mediaId ?? null),
    panels: [...new Set(input.panels)],
    targetMode: input.targetMode,
    durationSec: input.durationSec,
    closable: input.closable,
    autoCloseSec: input.autoCloseSec ?? null,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    everyMinutes: input.everyMinutes,
    maxPerDay: input.maxPerDay ?? null,
    priority: input.priority,
    status: input.status,
  });

  router.get('/control/ads', ...authed, async (_req, res) => {
    const [ads, stats, deliveries] = await Promise.all([
      db.adCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { targets: true },
      }),
      db.adStat.groupBy({
        by: ['campaignId'],
        _sum: { shown: true, closed: true },
      }),
      db.adDelivery.groupBy({
        by: ['campaignId'],
        where: { ackedAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    res.json({
      ads: ads.map((ad) =>
        adRow(ad, {
          shown: stats.find((row) => row.campaignId === ad.id)?._sum.shown ?? 0,
          closed:
            stats.find((row) => row.campaignId === ad.id)?._sum.closed ?? 0,
          delivered:
            deliveries.find((row) => row.campaignId === ad.id)?._count._all ??
            0,
        }),
      ),
    });
  });

  router.post('/control/ads', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const input = parse(adBody, req.body);
    await checkReferences(input);
    const ad = await db.adCampaign.create({
      data: {
        ...dataOf(input),
        createdById: owner.ownerId,
        ...(input.targetMode === 'SELECTED'
          ? {
              targets: {
                create: [...new Set(input.customerIds)].map((customerId) => ({
                  customerId,
                })),
              },
            }
          : {}),
      },
      include: { targets: true },
    });
    await audit(req, owner.ownerId, 'branding.ad.create', ad.id, {
      format: ad.format,
      status: ad.status,
      targetMode: ad.targetMode,
    });
    await notify(
      ad.targetMode === 'ALL' ? 'all' : ad.targets.map((t) => t.customerId),
    );
    res.status(201).json({ ad: adRow(ad) });
  });

  router.put('/control/ads/:id', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const input = parse(adBody, req.body);
    const before = await db.adCampaign.findUnique({
      where: { id },
      include: { targets: true },
    });
    if (!before) throw errors.notFound();
    await checkReferences(input);
    const ad = await db.$transaction(async (tx) => {
      await tx.adTarget.deleteMany({ where: { campaignId: id } });
      return tx.adCampaign.update({
        where: { id },
        data: {
          ...dataOf(input),
          version: { increment: 1 },
          ...(input.targetMode === 'SELECTED'
            ? {
                targets: {
                  create: [...new Set(input.customerIds)].map((customerId) => ({
                    customerId,
                  })),
                },
              }
            : {}),
        },
        include: { targets: true },
      });
    });
    await audit(req, owner.ownerId, 'branding.ad.update', id, {
      from: { status: before.status, title: before.title },
      to: { status: ad.status, title: ad.title },
    });
    await notify('all');
    res.json({ ad: adRow(ad) });
  });

  router.post('/control/ads/:id/status', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    const { status } = parse(
      z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED']) }),
      req.body,
    );
    const before = await db.adCampaign.findUnique({ where: { id } });
    if (!before) throw errors.notFound();
    await db.adCampaign.update({
      where: { id },
      data: { status, version: { increment: 1 } },
    });
    await audit(req, owner.ownerId, 'branding.ad.status', id, {
      from: before.status,
      to: status,
    });
    await notify('all');
    res.json({ ok: true });
  });

  router.delete('/control/ads/:id', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    const id = idParam(req.params.id);
    parse(z.object({ confirm: z.literal(true) }), req.body);
    const before = await db.adCampaign.findUnique({ where: { id } });
    if (!before) throw errors.notFound();
    await db.$transaction([
      db.adStat.deleteMany({ where: { campaignId: id } }),
      db.adDelivery.deleteMany({ where: { campaignId: id } }),
      db.adCampaign.delete({ where: { id } }),
    ]);
    await audit(req, owner.ownerId, 'branding.ad.delete', id, {
      title: before.title,
    });
    await notify('all');
    res.json({ ok: true });
  });

  router.get('/control/ads/:id/stats', ...authed, async (req, res) => {
    const id = idParam(req.params.id);
    const ad = await db.adCampaign.findUnique({ where: { id } });
    if (!ad) throw errors.notFound();
    const [stats, deliveries, customers] = await Promise.all([
      db.adStat.findMany({ where: { campaignId: id } }),
      db.adDelivery.findMany({ where: { campaignId: id } }),
      db.controlCustomer.findMany({ select: { id: true, name: true } }),
    ]);
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const byCustomer = new Map<
      string,
      { shown: number; closed: number; delivered: number; pending: number }
    >();
    const row = (customerId: string) => {
      let entry = byCustomer.get(customerId);
      if (!entry) {
        entry = { shown: 0, closed: 0, delivered: 0, pending: 0 };
        byCustomer.set(customerId, entry);
      }
      return entry;
    };
    for (const stat of stats) {
      row(stat.customerId).shown += stat.shown;
      row(stat.customerId).closed += stat.closed;
    }
    for (const delivery of deliveries)
      if (delivery.ackedAt && delivery.version === ad.version)
        row(delivery.customerId).delivered += 1;
      else row(delivery.customerId).pending += 1;
    res.json({
      customers: [...byCustomer.entries()].map(([customerId, value]) => ({
        customerId,
        name: names.get(customerId) ?? '—',
        ...value,
      })),
    });
  });

  // ---- design ---------------------------------------------------------------
  router.get('/control/design', ...authed, async (_req, res) => {
    const [rows, customers] = await Promise.all([
      db.brandingDesign.findMany(),
      db.controlCustomer.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, status: true },
      }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    res.json({
      skins: SKINS.map((key) => ({ key, ...SKIN_LABELS[key] })),
      global: byKey.get('global') ? layerOf(byKey.get('global')!.config) : null,
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        status: customer.status,
        config: byKey.get(customer.id)
          ? layerOf(byKey.get(customer.id)!.config)
          : null,
      })),
    });
  });

  async function saveDesign(
    req: Parameters<typeof controlAudit>[1],
    ownerId: string,
    key: string,
    layer: DesignLayer,
    customerId?: string,
  ) {
    // Pictures must exist: an unknown id would break every screen that shows it.
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
    const before = await db.brandingDesign.findUnique({ where: { key } });
    const row = await db.brandingDesign.upsert({
      where: { key },
      create: {
        key,
        config: layer as Prisma.InputJsonValue,
        updatedById: ownerId,
      },
      update: {
        config: layer as Prisma.InputJsonValue,
        version: { increment: 1 },
        updatedById: ownerId,
      },
    });
    await audit(
      req,
      ownerId,
      key === 'global' ? 'branding.design.global.set' : 'branding.design.set',
      key,
      { from: before?.config ?? null, to: row.config },
      customerId,
    );
  }

  router.put('/control/design/global', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    await saveDesign(
      req,
      owner.ownerId,
      'global',
      parse(designLayerSchema, req.body),
    );
    await notify('all');
    res.json({ ok: true });
  });

  router.delete('/control/design/global', ...sensitive, async (req, res) => {
    const owner = getOwner(res);
    parse(z.object({ confirm: z.literal(true) }), req.body);
    await db.brandingDesign.deleteMany({ where: { key: 'global' } });
    await audit(req, owner.ownerId, 'branding.design.global.reset', 'global');
    await notify('all');
    res.json({ ok: true });
  });

  router.put('/control/customers/:id/design', ...authed, async (req, res) => {
    const owner = getOwner(res);
    const customerId = idParam(req.params.id);
    if (!(await db.controlCustomer.findUnique({ where: { id: customerId } })))
      throw errors.notFound();
    await saveDesign(
      req,
      owner.ownerId,
      customerId,
      parse(designLayerSchema, req.body),
      customerId,
    );
    await notify([customerId]);
    res.json({ ok: true });
  });

  router.delete(
    '/control/customers/:id/design',
    ...authed,
    async (req, res) => {
      const owner = getOwner(res);
      const customerId = idParam(req.params.id);
      parse(z.object({ confirm: z.literal(true) }), req.body);
      await db.brandingDesign.deleteMany({ where: { key: customerId } });
      await audit(
        req,
        owner.ownerId,
        'branding.design.reset',
        customerId,
        undefined,
        customerId,
      );
      await notify([customerId]);
      res.json({ ok: true });
    },
  );

  return router;
}
