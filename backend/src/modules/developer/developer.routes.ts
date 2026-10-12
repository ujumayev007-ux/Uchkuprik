import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { messages } from '../../messages.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';
import { entitlementsOf } from '../billing/entitlements.js';
import { publicMenu } from '../online/online.routes.js';
import { assertPublicUrl, emitWebhook, webhookEvents } from './webhooks.js';

export const apiScopes = ['orders.read', 'menu.read', 'reports.read'] as const;
type ApiScope = (typeof apiScopes)[number];

type ApiContext = { tenantId: string; keyId: string; scopes: Set<string> };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

export function developerRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [requireAuth(), requirePermission('developer.manage')];

  // ---------------------------------------------------------------- API keys

  router.get('/developer/api-keys', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const keys = await db.apiKey.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    res.json({ keys, scopes: apiScopes });
  });

  // The full key is shown exactly once; only its SHA-256 hash is stored.
  router.post(
    '/developer/api-keys',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z.object({
          name: z.string().trim().min(2).max(80),
          scopes: z.array(z.enum(apiScopes)).min(1).max(apiScopes.length),
        }),
        req.body,
      );
      const key = `ffk_${randomToken()}`;
      const created = await db.$transaction(async (tx) => {
        const row = await tx.apiKey.create({
          data: {
            tenantId: auth.tenantId,
            name: input.name,
            prefix: key.slice(0, 12),
            keyHash: sha256(key),
            scopes: [...new Set(input.scopes)],
            createdById: auth.userId,
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'developer.api_key.create',
          entityType: 'api_key',
          entityId: row.id,
          data: { name: input.name, scopes: input.scopes },
        });
        return row;
      });
      res.status(201).json({ id: created.id, key });
    },
  );

  router.post(
    '/developer/api-keys/:id/revoke',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const result = await tx.apiKey.updateMany({
          where: { id, tenantId: auth.tenantId, revokedAt: null },
          data: { revokedAt: now() },
        });
        if (result.count === 0) throw errors.conflict();
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'developer.api_key.revoke',
          entityType: 'api_key',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  // ---------------------------------------------------------------- webhooks

  router.get('/developer/webhooks', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const endpoints = await db.webhookEndpoint.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
      },
    });
    res.json({ endpoints, events: webhookEvents });
  });

  const endpointInput = z.object({
    url: z.url({ protocol: /^https$/ }).max(500),
    events: z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length),
    isActive: z.boolean().default(true),
  });

  async function checkUrl(url: string) {
    try {
      await assertPublicUrl(url);
    } catch {
      throw new AppError(400, 'WEBHOOK_URL_INVALID', 'webhookUrlInvalid');
    }
  }

  // The signing secret is returned once at creation.
  router.post(
    '/developer/webhooks',
    ...manage,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(endpointInput, req.body);
      if (!services.webhookSender) await checkUrl(input.url);
      const secret = `whsec_${randomToken()}`;
      const endpoint = await db.$transaction(async (tx) => {
        const row = await tx.webhookEndpoint.create({
          data: {
            tenantId: auth.tenantId,
            url: input.url,
            events: [...new Set(input.events)],
            isActive: input.isActive,
            secretEnc: services.secrets.encrypt(secret),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'developer.webhook.create',
          entityType: 'webhook_endpoint',
          entityId: row.id,
          data: { url: input.url, events: input.events },
        });
        return row;
      });
      res.status(201).json({ id: endpoint.id, secret });
    },
  );

  router.put('/developer/webhooks/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(endpointInput, req.body);
    if (!services.webhookSender) await checkUrl(input.url);
    const result = await db.webhookEndpoint.updateMany({
      where: { id, tenantId: auth.tenantId },
      data: {
        url: input.url,
        events: [...new Set(input.events)],
        isActive: input.isActive,
      },
    });
    if (result.count === 0) throw errors.notFound();
    res.json({ ok: true });
  });

  router.get(
    '/developer/webhooks/:id/deliveries',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const deliveries = await db.webhookDelivery.findMany({
        where: { tenantId: auth.tenantId, endpointId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          event: true,
          status: true,
          attempts: true,
          responseStatus: true,
          lastError: true,
          createdAt: true,
          sentAt: true,
        },
      });
      res.json({ deliveries });
    },
  );

  router.post(
    '/developer/deliveries/:id/retry',
    ...manage,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const result = await db.webhookDelivery.updateMany({
        where: { id, tenantId: auth.tenantId, status: 'FAILED' },
        data: { status: 'PENDING', attempts: 0, nextTryAt: now() },
      });
      if (result.count === 0) throw errors.conflict();
      res.json({ ok: true });
    },
  );

  router.post('/developer/webhooks/:id/test', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const endpoint = await db.webhookEndpoint.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!endpoint) throw errors.notFound();
    await db.webhookDelivery.create({
      data: {
        tenantId: auth.tenantId,
        endpointId: endpoint.id,
        event: 'ping',
        payload: { event: 'ping', data: { ok: true } },
      },
    });
    res.json({ queued: true });
  });

  return router;
}

// --------------------------------------------------------------- public API v1

/** Authenticates `Authorization: Bearer ffk_...` keys for the public API. */
function apiKeyAuth(services: Services) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const key = header.match(/^Bearer (ffk_[A-Za-z0-9_-]{20,100})$/)?.[1];
    if (!key) throw new AppError(401, 'API_KEY_REQUIRED', 'apiKeyRequired');
    const row = await services.db.apiKey.findUnique({
      where: { keyHash: sha256(key) },
    });
    if (!row || row.revokedAt)
      throw new AppError(401, 'API_KEY_INVALID', 'apiKeyInvalid');
    const tenant = await services.db.tenant.findUnique({
      where: { id: row.tenantId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!tenant || tenant.status !== 'ACTIVE')
      throw new AppError(403, 'TENANT_SUSPENDED', 'tenantSuspended');
    const { features } = entitlementsOf(tenant.subscription);
    if (features !== null && !features.includes('developer_api'))
      throw new AppError(403, 'FEATURE_NOT_IN_PLAN', 'featureNotInPlan', {
        feature: 'developer_api',
      });
    const now = services.now?.() ?? new Date();
    // Usage timestamp, written at most once a minute.
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000)
      await services.db.apiKey.update({
        where: { id: row.id },
        data: { lastUsedAt: now },
      });
    res.locals.api = {
      tenantId: row.tenantId,
      keyId: row.id,
      scopes: new Set(row.scopes),
    } satisfies ApiContext;
    next();
  };
}

function scope(required: ApiScope) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const api = res.locals.api as ApiContext;
    if (!api.scopes.has(required))
      throw new AppError(403, 'API_SCOPE_MISSING', 'apiScopeMissing', {
        scope: required,
      });
    next();
  };
}

export function publicApiRouter(services: Services) {
  const { db } = services;
  const router = Router();
  router.use(
    '/v1',
    rateLimit({
      windowMs: 60_000,
      limit: services.limits?.apiPerMinute ? services.limits.apiPerMinute : 120,
      keyGenerator: (req) => `k:${sha256(req.get('authorization') ?? '')}`,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { code: 'RATE_LIMITED', message: messages.rateLimited },
    }),
    apiKeyAuth(services),
  );
  const ctx = (res: Response) => res.locals.api as ApiContext;

  async function branchOf(tenantId: string, branchId: string | undefined) {
    const branch = await db.branch.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        ...(branchId ? { id: branchId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) throw errors.notFound();
    return branch;
  }

  router.get('/v1/branches', async (_req, res) => {
    const branches = await db.branch.findMany({
      where: { tenantId: ctx(res).tenantId, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        address: true,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json({ data: branches });
  });

  router.get('/v1/menu', scope('menu.read'), async (req, res) => {
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await branchOf(ctx(res).tenantId, branchId);
    res.json({
      branchId: branch.id,
      ...(await publicMenu(db, ctx(res).tenantId, branch.id)),
    });
  });

  // Orders without internal costs; cursor pagination by id.
  router.get('/v1/orders', scope('orders.read'), async (req, res) => {
    const query = parse(
      z.object({
        from: isoDate,
        to: isoDate,
        branchId: z.uuid().optional(),
        status: z
          .enum([
            'PENDING',
            'PLACED',
            'PREPARING',
            'READY',
            'SERVED',
            'COMPLETED',
            'CANCELLED',
          ])
          .optional(),
        cursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const orders = await db.order.findMany({
      where: {
        tenantId: ctx(res).tenantId,
        businessDate: { gte: day(query.from), lte: day(query.to) },
        status: query.status ?? { not: 'DRAFT' },
        ...(query.branchId ? { branchId: query.branchId } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        number: true,
        branchId: true,
        businessDate: true,
        type: true,
        channel: true,
        status: true,
        subtotal: true,
        discountTotal: true,
        total: true,
        createdAt: true,
        completedAt: true,
        items: {
          where: { status: 'ACTIVE' },
          select: {
            productName: true,
            variantName: true,
            quantity: true,
            unitPrice: true,
            lineTotal: true,
          },
        },
      },
    });
    const more = orders.length > query.limit;
    const data = more ? orders.slice(0, query.limit) : orders;
    res.json({ data, nextCursor: more ? data[data.length - 1]!.id : null });
  });

  router.get('/v1/reports/sales', scope('reports.read'), async (req, res) => {
    const query = parse(z.object({ from: isoDate, to: isoDate }), req.query);
    const rows = await db.order.groupBy({
      by: ['businessDate', 'branchId'],
      where: {
        tenantId: ctx(res).tenantId,
        status: 'COMPLETED',
        businessDate: { gte: day(query.from), lte: day(query.to) },
      },
      _sum: { total: true },
      _count: true,
      orderBy: { businessDate: 'asc' },
    });
    res.json({
      data: rows.map((row) => ({
        date: row.businessDate.toISOString().slice(0, 10),
        branchId: row.branchId,
        orders: row._count,
        revenue: row._sum.total ?? 0,
      })),
    });
  });

  return router;
}

export { emitWebhook };
