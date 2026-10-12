import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { passwordSchema } from '../auth/auth.routes.js';
import {
  getAuth,
  requireAuth,
  requirePlatformAdmin,
  requireRecentAuth,
} from '../auth/session.js';
import { startTrial } from '../billing/lifecycle.js';
import { createBusinessTenant, PLATFORM_SLUG } from './provisioning.js';

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
  .refine((slug) => slug !== PLATFORM_SLUG);

export function platformRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const admin = [requireAuth(), requirePlatformAdmin()];

  router.get('/platform/tenants', ...admin, async (_req, res) => {
    const tenants = await db.tenant.findMany({
      where: { kind: 'BUSINESS' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { branches: true, users: true } } },
    });
    res.json({
      tenants: tenants.map((tenant) => ({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        branchCount: tenant._count.branches,
        userCount: tenant._count.users,
        createdAt: tenant.createdAt,
      })),
    });
  });

  router.post(
    '/platform/tenants',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(
        z.object({
          slug: slugSchema,
          name: z.string().trim().min(2).max(100),
          branchName: z.string().trim().min(2).max(80),
          owner: z.object({
            username: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z0-9._-]{3,40}$/),
            displayName: z.string().trim().min(2).max(80),
            password: z.string(),
          }),
          // Optional: start a trial on this plan; without it the tenant is unrestricted.
          planCode: z.string().trim().toUpperCase().max(20).optional(),
        }),
        req.body,
      );
      if (!passwordSchema.safeParse(input.owner.password).success)
        throw new AppError(400, 'WEAK_PASSWORD', 'weakPassword');
      try {
        const created = await db.$transaction(async (tx) => {
          const result = await createBusinessTenant(tx, input);
          if (
            input.planCode &&
            !(await startTrial(
              tx,
              result.tenant.id,
              input.planCode,
              services.now?.() ?? new Date(),
            ))
          )
            throw errors.validation([{ path: 'planCode' }]);
          await audit(tx, req, {
            tenantId: result.tenant.id,
            actorUserId: auth.userId,
            action: 'platform.tenant.create',
            entityType: 'tenant',
            entityId: result.tenant.id,
            data: { slug: input.slug, platformTenantId: auth.tenantId },
          });
          return result;
        });
        res.status(201).json({ id: created.tenant.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.post(
    '/platform/tenants/:id/status',
    ...admin,
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { status } = parse(
        z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const result = await tx.tenant.updateMany({
          where: { id, kind: 'BUSINESS', status: { not: 'CLOSED' } },
          data: { status },
        });
        if (result.count === 0) throw errors.notFound();
        await audit(tx, req, {
          tenantId: id,
          actorUserId: auth.userId,
          action:
            status === 'SUSPENDED'
              ? 'platform.tenant.suspend'
              : 'platform.tenant.reactivate',
          entityType: 'tenant',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  return router;
}
