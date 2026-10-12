import { Router } from 'express';
import { z } from 'zod';
import { assertWithinLimit } from '../billing/entitlements.js';
import { assertBrand } from '../brands/brands.routes.js';
import type { Services } from '../../context.js';
import { errors, isUniqueViolation, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  requireRecentAuth,
} from '../auth/session.js';

const branchInput = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,30}$/),
  name: z.string().trim().min(2).max(80),
  address: z.string().trim().max(200).nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .nullable()
    .optional(),
  timezone: z.string().trim().min(3).max(60).default('Asia/Tashkent'),
  isActive: z.boolean().default(true),
  brandId: z.uuid().nullable().optional(),
});

export function branchesRouter(services: Services) {
  const { db } = services;
  const router = Router();

  // Every business user sees the branches they may work in (needed for branch switching).
  router.get('/branches', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const seeAll = auth.allBranches || auth.permissions.has('branches.view');
    const branches = await db.branch.findMany({
      where: {
        tenantId: auth.tenantId,
        deletedAt: null,
        ...(seeAll ? {} : { id: { in: auth.branchIds } }),
      },
      orderBy: { name: 'asc' },
    });
    res.json({
      branches: branches.map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        timezone: branch.timezone,
        currency: branch.currency,
        isActive: branch.isActive,
        brandId: branch.brandId,
      })),
    });
  });

  router.post(
    '/branches',
    requireAuth(),
    requirePermission('branches.manage'),
    requireRecentAuth(services),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(branchInput, req.body);
      try {
        const branch = await db.$transaction(async (tx) => {
          if (input.isActive)
            await assertWithinLimit(tx, auth.tenantId, 'branches');
          await assertBrand(tx, auth.tenantId, input.brandId);
          const created = await tx.branch.create({
            data: {
              tenantId: auth.tenantId,
              code: input.code,
              name: input.name,
              address: input.address ?? null,
              phone: input.phone ?? null,
              timezone: input.timezone,
              isActive: input.isActive,
              brandId: input.brandId ?? null,
            },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            branchId: created.id,
            actorUserId: auth.userId,
            action: 'branch.create',
            entityType: 'branch',
            entityId: created.id,
          });
          return created;
        });
        res.status(201).json({ id: branch.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.patch(
    '/branches/:id',
    requireAuth(),
    requirePermission('branches.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(branchInput, req.body);
      try {
        await db.$transaction(async (tx) => {
          const found = await tx.branch.findFirst({
            where: { id, tenantId: auth.tenantId, deletedAt: null },
          });
          if (!found) throw errors.notFound();
          if (input.isActive && !found.isActive)
            await assertWithinLimit(tx, auth.tenantId, 'branches');
          await assertBrand(tx, auth.tenantId, input.brandId);
          await tx.branch.update({
            where: { id },
            data: {
              code: input.code,
              name: input.name,
              address: input.address ?? null,
              phone: input.phone ?? null,
              timezone: input.timezone,
              isActive: input.isActive,
              brandId: input.brandId ?? null,
            },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            branchId: id,
            actorUserId: auth.userId,
            action: 'branch.update',
            entityType: 'branch',
            entityId: id,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
