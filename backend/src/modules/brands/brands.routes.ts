import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Db, Tx } from '../../db.js';
import { errors, isUniqueViolation, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  canAccessBranch,
  getAuth,
  requireAuth,
  requirePermission,
} from '../auth/session.js';

const brandInput = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/),
  name: z.string().trim().min(2).max(80),
  logoUrl: z
    .url({ protocol: /^https$/ })
    .max(500)
    .nullable()
    .optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  receiptHeader: z.string().trim().max(300).nullable().optional(),
  receiptFooter: z.string().trim().max(300).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

/** Validates that a brand id belongs to the tenant; null clears the brand. */
export async function assertBrand(
  tx: Db | Tx,
  tenantId: string,
  brandId: string | null | undefined,
) {
  if (!brandId) return;
  const brand = await tx.brand.findFirst({ where: { id: brandId, tenantId } });
  if (!brand) throw errors.validation([{ path: 'brandId' }]);
}

/** A category is sold at a branch when it is shared or belongs to the branch's brand. */
export function categoryVisible(
  category: { brandId: string | null },
  branch: { brandId: string | null },
) {
  return category.brandId === null || category.brandId === branch.brandId;
}

/** Normalizes optional fields to null for storage. */
function brandData(input: z.infer<typeof brandInput>) {
  return {
    ...input,
    logoUrl: input.logoUrl ?? null,
    primaryColor: input.primaryColor ?? null,
    receiptHeader: input.receiptHeader || null,
    receiptFooter: input.receiptFooter || null,
  };
}

function brandView(brand: {
  id: string;
  code: string;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  isActive: boolean;
  sortOrder: number;
}) {
  return {
    id: brand.id,
    code: brand.code,
    name: brand.name,
    logoUrl: brand.logoUrl,
    primaryColor: brand.primaryColor,
    receiptHeader: brand.receiptHeader,
    receiptFooter: brand.receiptFooter,
    isActive: brand.isActive,
    sortOrder: brand.sortOrder,
  };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function brandsRouter(services: Services) {
  const { db } = services;
  const router = Router();

  router.get('/brands', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const brands = await db.brand.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: {
            branches: { where: { deletedAt: null } },
            categories: true,
          },
        },
      },
    });
    res.json({
      brands: brands.map((brand) => ({
        ...brandView(brand),
        branchCount: brand._count.branches,
        categoryCount: brand._count.categories,
      })),
    });
  });

  router.post(
    '/brands',
    requireAuth(),
    requirePermission('brands.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const input = parse(brandInput, req.body);
      try {
        const brand = await db.$transaction(async (tx) => {
          const created = await tx.brand.create({
            data: { tenantId: auth.tenantId, ...brandData(input) },
          });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'brand.create',
            entityType: 'brand',
            entityId: created.id,
            data: { code: input.code, name: input.name },
          });
          return created;
        });
        res.status(201).json({ id: brand.id });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  router.put(
    '/brands/:id',
    requireAuth(),
    requirePermission('brands.manage'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(brandInput, req.body);
      try {
        await db.$transaction(async (tx) => {
          const found = await tx.brand.findFirst({
            where: { id, tenantId: auth.tenantId },
          });
          if (!found) throw errors.notFound();
          await tx.brand.update({ where: { id }, data: brandData(input) });
          await audit(tx, req, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'brand.update',
            entityType: 'brand',
            entityId: id,
            data: { code: input.code, isActive: input.isActive },
          });
        });
        res.json({ ok: true });
      } catch (error) {
        if (isUniqueViolation(error)) throw errors.conflict();
        throw error;
      }
    },
  );

  // Cross-brand comparison of completed sales for the branches the user can access.
  router.get(
    '/reports/brands',
    requireAuth(),
    requirePermission('reports.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(z.object({ from: day, to: day }), req.query);
      const from = new Date(`${query.from}T00:00:00.000Z`);
      const to = new Date(`${query.to}T00:00:00.000Z`);
      if (to < from || to.getTime() - from.getTime() > 400 * 86_400_000)
        throw errors.validation([{ path: 'to' }]);
      const [brands, branches, totals] = await Promise.all([
        db.brand.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        db.branch.findMany({
          where: { tenantId: auth.tenantId, deletedAt: null },
          select: { id: true, name: true, brandId: true },
        }),
        db.order.groupBy({
          by: ['branchId'],
          where: {
            tenantId: auth.tenantId,
            status: 'COMPLETED',
            businessDate: { gte: from, lte: to },
          },
          _sum: { total: true },
          _count: { _all: true },
        }),
      ]);
      const visible = branches.filter((branch) =>
        canAccessBranch(auth, branch.id),
      );
      const rows = [
        ...brands.map((brand) => ({ id: brand.id, name: brand.name })),
        { id: null, name: null },
      ].map((brand) => {
        const own = visible.filter((branch) => branch.brandId === brand.id);
        const sums = own.map(
          (branch) =>
            totals.find((row) => row.branchId === branch.id) ?? {
              _sum: { total: 0 },
              _count: { _all: 0 },
            },
        );
        const revenue = sums.reduce(
          (sum, row) => sum + (row._sum.total ?? 0),
          0,
        );
        const orders = sums.reduce((sum, row) => sum + row._count._all, 0);
        return {
          brandId: brand.id,
          brandName: brand.name,
          branchCount: own.length,
          orders,
          revenue,
          averageCheck: orders > 0 ? Math.round(revenue / orders) : 0,
          branches: own.map((branch) => {
            const row = totals.find((item) => item.branchId === branch.id);
            return {
              branchId: branch.id,
              name: branch.name,
              orders: row?._count._all ?? 0,
              revenue: row?._sum.total ?? 0,
            };
          }),
        };
      });
      res.json({
        brands: rows.filter(
          (row) => row.brandId !== null || row.branchCount > 0,
        ),
      });
    },
  );

  return router;
}
