import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { assertBrand, categoryVisible } from '../brands/brands.routes.js';
import { sha256Of, sniffMedia } from '../branding/media.js';
import {
  checkRows,
  importTemplate,
  MAX_IMPORT_ROWS,
  normal,
  readFirstSheet,
} from './import.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';

const amount = z.number().int().min(0).max(1_000_000_000);

// Pictures uploaded from the Admin (already reduced by the app) are served from here.
const LOCAL_IMAGE = /^\/api\/menu\/images\/[0-9a-f-]{36}$/;
const localImageId = (url: string | null | undefined) =>
  url && LOCAL_IMAGE.test(url) ? url.slice(url.lastIndexOf('/') + 1) : null;
const MAX_PRODUCT_IMAGE_BYTES = 1024 * 1024;
const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const categoryInput = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: z.uuid().nullable().optional(),
  stationId: z.uuid().nullable().optional(),
  brandId: z.uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

const variantInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(60),
  price: amount,
  cost: amount.nullable().optional(),
  isActive: z.boolean().default(true),
});

const productInput = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  description: optionalText(1000),
  sku: z.string().trim().min(1).max(40).nullable().optional(),
  barcode: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,32}$/)
    .nullable()
    .optional(),
  // An HTTPS link or a picture uploaded to this server.
  imageUrl: z
    .string()
    .trim()
    .max(1000)
    .refine(
      (value) =>
        LOCAL_IMAGE.test(value) ||
        (value.startsWith('https://') && z.url().safeParse(value).success),
    )
    .nullable()
    .optional(),
  allergens: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  prepTimeMinutes: z.number().int().min(0).max(600).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  variants: z.array(variantInput).min(1).max(20),
  modifierGroupIds: z.array(z.uuid()).max(20).default([]),
});

const optionInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(60),
  price: amount,
  cost: amount.nullable().optional(),
  isActive: z.boolean().default(true),
});

const groupInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    isActive: z.boolean().default(true),
    options: z.array(optionInput).min(1).max(50),
  })
  .refine((group) => group.minSelect <= group.maxSelect, {
    path: ['minSelect'],
  });

const canSeeCost = (auth: AuthContext) =>
  auth.permissions.has('menu.cost.view') && auth.financial.cost;

async function assertCategoryParent(
  tx: Tx,
  tenantId: string,
  id: string | null,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  // Walk up the tree to reject cycles; depth is bounded to keep menus navigable.
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (current === id || depth > 4)
      throw new AppError(400, 'CATEGORY_CYCLE', 'categoryCycle');
    const parent: { parentId: string | null } | null =
      await tx.menuCategory.findFirst({
        where: { id: current, tenantId },
        select: { parentId: true },
      });
    if (!parent) throw errors.validation([{ path: 'parentId' }]);
    current = parent.parentId;
  }
}

async function assertStation(
  tx: Tx,
  tenantId: string,
  stationId: string | null | undefined,
) {
  if (!stationId) return;
  const station = await tx.kitchenStation.findFirst({
    where: { id: stationId, tenantId },
  });
  if (!station) throw errors.validation([{ path: 'stationId' }]);
}

/** Upserts variants by id; variants missing from the input are deactivated, not deleted,
 * because historical orders reference them. */
async function syncVariants(
  tx: Tx,
  auth: AuthContext,
  productId: string,
  variants: z.infer<typeof variantInput>[],
) {
  const existing = await tx.productVariant.findMany({
    where: { productId, tenantId: auth.tenantId },
  });
  const known = new Map(existing.map((variant) => [variant.id, variant]));
  const keep = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    // Without menu.cost.view the submitted cost is ignored and the stored cost kept.
    const cost = canSeeCost(auth) ? (variant.cost ?? null) : undefined;
    if (variant.id) {
      const current = known.get(variant.id);
      if (!current) throw errors.validation([{ path: `variants.${index}.id` }]);
      keep.add(variant.id);
      await tx.productVariant.update({
        where: { id: variant.id },
        data: {
          name: variant.name,
          price: variant.price,
          isActive: variant.isActive,
          sortOrder: index,
          ...(cost === undefined ? {} : { cost }),
        },
      });
    } else {
      await tx.productVariant.create({
        data: {
          tenantId: auth.tenantId,
          productId,
          name: variant.name,
          price: variant.price,
          cost: cost ?? null,
          isActive: variant.isActive,
          sortOrder: index,
        },
      });
    }
  }
  const removed = existing
    .filter((variant) => !keep.has(variant.id))
    .map((variant) => variant.id);
  if (removed.length)
    await tx.productVariant.updateMany({
      where: { id: { in: removed } },
      data: { isActive: false },
    });
  const active = await tx.productVariant.count({
    where: { productId, isActive: true },
  });
  if (active === 0)
    throw new AppError(400, 'VARIANT_REQUIRED', 'variantRequired');
}

async function syncModifierGroups(
  tx: Tx,
  tenantId: string,
  productId: string,
  groupIds: string[],
) {
  const unique = [...new Set(groupIds)];
  const found = await tx.modifierGroup.count({
    where: { tenantId, id: { in: unique } },
  });
  if (found !== unique.length)
    throw errors.validation([{ path: 'modifierGroupIds' }]);
  await tx.productModifierGroup.deleteMany({ where: { productId } });
  await tx.productModifierGroup.createMany({
    data: unique.map((groupId, sortOrder) => ({
      tenantId,
      productId,
      groupId,
      sortOrder,
    })),
  });
}

export function menuRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const manage = [requireAuth(), requirePermission('menu.manage')];

  // Open POS screens refresh prices and stop-lists after any successful menu change.
  router.use('/menu', (req, res, next) => {
    if (req.method !== 'GET')
      res.on('finish', () => {
        const auth = res.locals.auth as AuthContext | undefined;
        if (auth && res.statusCode < 300)
          services.events?.publish({
            type: 'menu.changed',
            tenantId: auth.tenantId,
          });
      });
    next();
  });
  const now = () => services.now?.() ?? new Date();

  router.get(
    '/menu',
    requireAuth(),
    requirePermission('menu.view'),
    async (req, res) => {
      const auth = getAuth(res);
      const query = parse(
        z.object({
          branchId: z.uuid().optional(),
          all: z.enum(['true', 'false']).default('false'),
        }),
        req.query,
      );
      const branch = await resolveBranch(db, auth, query.branchId);
      // Inactive items are only shown to managers editing the menu.
      const includeInactive =
        query.all === 'true' && auth.permissions.has('menu.manage');
      const costs = canSeeCost(auth);
      const active = includeInactive ? {} : { isActive: true };
      const [categories, products, groups] = await Promise.all([
        db.menuCategory.findMany({
          where: { tenantId: auth.tenantId, ...active },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        db.product.findMany({
          where: { tenantId: auth.tenantId, deletedAt: null, ...active },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            variants: {
              where: active,
              orderBy: { sortOrder: 'asc' },
              include: { branchPrices: { where: { branchId: branch.id } } },
            },
            modifierGroups: { orderBy: { sortOrder: 'asc' } },
          },
        }),
        db.modifierGroup.findMany({
          where: { tenantId: auth.tenantId, ...active },
          orderBy: { name: 'asc' },
          include: {
            options: { where: active, orderBy: { sortOrder: 'asc' } },
          },
        }),
      ]);
      // Selling views only show shared categories and those of the branch's brand.
      const shown = includeInactive
        ? categories
        : categories.filter((category) => categoryVisible(category, branch));
      const shownIds = new Set(shown.map((category) => category.id));
      const comboRows = await db.comboComponent.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { sortOrder: 'asc' },
        select: { variantId: true, componentVariantId: true, quantity: true },
      });
      res.json({
        branchId: branch.id,
        brandId: branch.brandId,
        categories: shown.map((category) => ({
          id: category.id,
          name: category.name,
          parentId: category.parentId,
          stationId: category.stationId,
          brandId: category.brandId,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
        })),
        products: products
          .filter((product) => shownIds.has(product.categoryId))
          .map((product) => ({
            id: product.id,
            categoryId: product.categoryId,
            name: product.name,
            description: product.description,
            sku: product.sku,
            barcode: product.barcode,
            imageUrl: product.imageUrl,
            allergens: product.allergens,
            prepTimeMinutes: product.prepTimeMinutes,
            isActive: product.isActive,
            sortOrder: product.sortOrder,
            version: product.version,
            modifierGroupIds: product.modifierGroups.map(
              (link) => link.groupId,
            ),
            variants: product.variants.map((variant) => {
              const override = variant.branchPrices[0];
              return {
                id: variant.id,
                name: variant.name,
                basePrice: variant.price,
                branchPrice: override?.price ?? null,
                price: override?.price ?? variant.price,
                available: variant.isActive && (override?.isAvailable ?? true),
                isActive: variant.isActive,
                // Set (combo) contents: other variants included at this price.
                components: comboRows
                  .filter((row) => row.variantId === variant.id)
                  .map((row) => ({
                    variantId: row.componentVariantId,
                    quantity: row.quantity,
                  })),
                ...(costs ? { cost: variant.cost } : {}),
              };
            }),
          })),
        modifierGroups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
          isActive: group.isActive,
          options: group.options.map((option) => ({
            id: option.id,
            name: option.name,
            price: option.price,
            isActive: option.isActive,
            ...(costs ? { cost: option.cost } : {}),
          })),
        })),
      });
    },
  );

  router.post('/menu/categories', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(categoryInput, req.body);
    const category = await db.$transaction(async (tx) => {
      await assertCategoryParent(tx, auth.tenantId, null, input.parentId);
      await assertStation(tx, auth.tenantId, input.stationId);
      await assertBrand(tx, auth.tenantId, input.brandId);
      const created = await tx.menuCategory.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          parentId: input.parentId ?? null,
          stationId: input.stationId ?? null,
          brandId: input.brandId ?? null,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'menu.category.create',
        entityType: 'menu_category',
        entityId: created.id,
      });
      return created;
    });
    res.status(201).json({ id: category.id });
  });

  router.patch('/menu/categories/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(categoryInput, req.body);
    await db.$transaction(async (tx) => {
      const category = await tx.menuCategory.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!category) throw errors.notFound();
      await assertCategoryParent(tx, auth.tenantId, id, input.parentId);
      await assertStation(tx, auth.tenantId, input.stationId);
      await assertBrand(tx, auth.tenantId, input.brandId);
      await tx.menuCategory.update({
        where: { id },
        data: {
          name: input.name,
          parentId: input.parentId ?? null,
          stationId: input.stationId ?? null,
          brandId: input.brandId ?? null,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'menu.category.update',
        entityType: 'menu_category',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  const writeProduct = async (
    tx: Tx,
    auth: AuthContext,
    input: z.infer<typeof productInput>,
    id: string | null,
    req: Request,
  ) => {
    const category = await tx.menuCategory.findFirst({
      where: { id: input.categoryId, tenantId: auth.tenantId },
    });
    if (!category) throw errors.validation([{ path: 'categoryId' }]);
    const data = {
      categoryId: input.categoryId,
      name: input.name,
      description: input.description ?? null,
      sku: input.sku ?? null,
      barcode: input.barcode ?? null,
      imageUrl: input.imageUrl ?? null,
      allergens: input.allergens,
      prepTimeMinutes: input.prepTimeMinutes ?? null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    };
    let productId: string;
    let before: unknown = null;
    if (id) {
      const current = await tx.product.findFirst({
        where: { id, tenantId: auth.tenantId, deletedAt: null },
        include: { variants: true },
      });
      if (!current) throw errors.notFound();
      before = {
        name: current.name,
        categoryId: current.categoryId,
        isActive: current.isActive,
        variants: current.variants.map((variant) => ({
          id: variant.id,
          name: variant.name,
          price: variant.price,
          isActive: variant.isActive,
        })),
      };
      await tx.product.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
      productId = id;
      // A replaced or removed uploaded picture is deleted when nothing else shows it.
      const oldImage = localImageId(current.imageUrl);
      if (oldImage && current.imageUrl !== data.imageUrl) {
        const stillUsed = await tx.product.count({
          where: { tenantId: auth.tenantId, imageUrl: current.imageUrl },
        });
        if (stillUsed === 0)
          await tx.productImage.deleteMany({
            where: { id: oldImage, tenantId: auth.tenantId },
          });
      }
    } else {
      const created = await tx.product.create({
        data: { tenantId: auth.tenantId, ...data },
      });
      productId = created.id;
    }
    await syncVariants(tx, auth, productId, input.variants);
    await syncModifierGroups(
      tx,
      auth.tenantId,
      productId,
      input.modifierGroupIds,
    );
    // Before/after snapshots in the immutable audit log form the product version history.
    await audit(tx, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: id ? 'menu.product.update' : 'menu.product.create',
      entityType: 'product',
      entityId: productId,
      data: JSON.parse(
        JSON.stringify({
          before,
          after: {
            name: input.name,
            categoryId: input.categoryId,
            isActive: input.isActive,
            variants: input.variants.map((variant) => ({
              id: variant.id ?? null,
              name: variant.name,
              price: variant.price,
              isActive: variant.isActive,
            })),
          },
        }),
      ),
    });
    return productId;
  };

  router.post('/menu/products', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(productInput, req.body);
    try {
      const id = await db.$transaction((tx) =>
        writeProduct(tx, auth, input, null, req),
      );
      res.status(201).json({ id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/menu/products/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(productInput, req.body);
    try {
      await db.$transaction((tx) => writeProduct(tx, auth, input, id, req));
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  // --- Excel import ---------------------------------------------------------------
  const importMenu = (tx: Tx, tenantId: string) =>
    Promise.all([
      tx.menuCategory.findMany({
        where: { tenantId },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      tx.product.findMany({
        where: { tenantId, deletedAt: null },
        select: { name: true, categoryId: true, sku: true, barcode: true },
      }),
    ]).then(([categories, products]) => ({ categories, products }));

  router.get('/menu/import/template', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const menu = await importMenu(db, auth.tenantId);
    const file = await importTemplate(menu.categories.map((c) => c.name));
    res
      .type(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader(
        'Content-Disposition',
        'attachment; filename="taomlar-namuna.xlsx"',
      )
      .send(file);
  });

  // mode=preview checks every row; mode=commit saves the rows that passed (in one
  // transaction, checked again) and never changes products already on the menu.
  router.post('/menu/import', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { mode } = parse(
      z.object({ mode: z.enum(['preview', 'commit']).default('preview') }),
      req.query,
    );
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    const sheet = bytes?.length ? readFirstSheet(bytes) : null;
    if (!sheet) throw new AppError(400, 'IMPORT_FILE', 'importFile');
    if (mode === 'preview') {
      const checked = checkRows(sheet, await importMenu(db, auth.tenantId));
      if (!checked.headerFound)
        throw new AppError(400, 'IMPORT_FILE', 'importFile');
      if (checked.rows.length > MAX_IMPORT_ROWS)
        throw new AppError(400, 'IMPORT_TOO_MANY', 'importTooMany');
      res.json({ rows: checked.rows });
      return;
    }
    const result = await db.$transaction(
      async (tx) => {
        const menu = await importMenu(tx, auth.tenantId);
        const checked = checkRows(sheet, menu);
        if (!checked.headerFound)
          throw new AppError(400, 'IMPORT_FILE', 'importFile');
        if (checked.rows.length > MAX_IMPORT_ROWS)
          throw new AppError(400, 'IMPORT_TOO_MANY', 'importTooMany');
        const good = checked.rows.filter((row) => row.errors.length === 0);
        const categoryIds = new Map(
          menu.categories.map((c) => [normal(c.name), c.id]),
        );
        for (const row of good) {
          const key = normal(row.category);
          let categoryId = categoryIds.get(key);
          if (!categoryId) {
            const created = await tx.menuCategory.create({
              data: { tenantId: auth.tenantId, name: row.category.trim() },
            });
            categoryId = created.id;
            categoryIds.set(key, categoryId);
          }
          await writeProduct(
            tx,
            auth,
            {
              categoryId,
              name: row.name,
              description: row.description,
              sku: row.sku,
              barcode: row.barcode,
              imageUrl: null,
              allergens: [],
              prepTimeMinutes: row.prepTimeMinutes,
              isActive: row.isActive,
              sortOrder: 0,
              variants: [
                {
                  name: row.variant,
                  price: row.price ?? 0,
                  cost: row.cost,
                  isActive: true,
                },
              ],
              modifierGroupIds: [],
            },
            null,
            req,
          );
        }
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'menu.import',
          entityType: 'menu',
          data: { created: good.length, rejected: checked.rows.length - good.length },
        });
        return {
          created: good.length,
          rejected: checked.rows.filter((row) => row.errors.length > 0),
        };
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    res.json(result);
  });

  // Product pictures: public like the menu itself (customer and Telegram menus show
  // them), served by an unguessable id with long caching.
  const imageLimiter = rateLimit({
    windowMs: 60_000,
    limit: 3000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.get('/menu/images/:id', imageLimiter, async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const row = id.success
      ? await db.productImage.findUnique({ where: { id: id.data } })
      : null;
    if (!row) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Topilmadi' });
      return;
    }
    const etag = `"${row.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const bytes = Buffer.from(row.data);
    res.type(row.mime).setHeader('Content-Length', String(bytes.length));
    res.send(bytes);
  });

  // Uploaded as the raw picture body; judged by its own bytes, never by its name.
  router.post('/menu/product-images', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0)
      throw errors.validation([{ path: 'file' }]);
    const found = sniffMedia(bytes);
    if (!found || !PRODUCT_IMAGE_TYPES.includes(found.mime))
      throw new AppError(400, 'MEDIA_INVALID', 'mediaInvalid');
    if (bytes.length > MAX_PRODUCT_IMAGE_BYTES)
      throw new AppError(413, 'MEDIA_TOO_LARGE', 'productImageTooLarge');
    const image = await db.$transaction(async (tx) => {
      const created = await tx.productImage.create({
        data: {
          tenantId: auth.tenantId,
          mime: found.mime,
          sizeBytes: bytes.length,
          sha256: sha256Of(bytes),
          data: Buffer.from(bytes),
          createdById: auth.userId,
        },
        select: { id: true },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'menu.image.upload',
        entityType: 'product_image',
        entityId: created.id,
      });
      return created;
    });
    res
      .status(201)
      .json({ id: image.id, url: `/api/menu/images/${image.id}` });
  });

  // "Ko‘rinadi / Yashirilgan": a hidden product leaves the Kassa, Ofitsiant and online
  // menus but is kept (orders and reports that name it are unchanged).
  router.patch('/menu/products/:id/visibility', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
    await db.$transaction(async (tx) => {
      const current = await tx.product.findFirst({
        where: { id, tenantId: auth.tenantId, deletedAt: null },
        select: { isActive: true },
      });
      if (!current) throw errors.notFound();
      if (current.isActive === isActive) return;
      await tx.product.update({
        where: { id },
        data: { isActive, version: { increment: 1 } },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: isActive ? 'menu.product.show' : 'menu.product.hide',
        entityType: 'product',
        entityId: id,
      });
    });
    res.json({ ok: true });
  });

  // Soft delete keeps order history intact; identifiers are released for reuse.
  router.delete('/menu/products/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      const result = await tx.product.updateMany({
        where: { id, tenantId: auth.tenantId, deletedAt: null },
        data: { deletedAt: now(), isActive: false, sku: null, barcode: null },
      });
      if (result.count === 0) throw errors.notFound();
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'menu.product.delete',
        entityType: 'product',
        entityId: id,
      });
    });
    res.status(204).end();
  });

  const writeGroup = async (
    tx: Tx,
    auth: AuthContext,
    input: z.infer<typeof groupInput>,
    id: string | null,
    req: Request,
  ) => {
    const data = {
      name: input.name,
      minSelect: input.minSelect,
      maxSelect: input.maxSelect,
      isActive: input.isActive,
    };
    let groupId: string;
    if (id) {
      const found = await tx.modifierGroup.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!found) throw errors.notFound();
      await tx.modifierGroup.update({ where: { id }, data });
      groupId = id;
    } else {
      groupId = (
        await tx.modifierGroup.create({
          data: { tenantId: auth.tenantId, ...data },
        })
      ).id;
    }
    const existing = await tx.modifierOption.findMany({
      where: { groupId, tenantId: auth.tenantId },
    });
    const known = new Set(existing.map((option) => option.id));
    const keep = new Set<string>();
    for (const [index, option] of input.options.entries()) {
      const cost = canSeeCost(auth) ? (option.cost ?? null) : undefined;
      const fields = {
        name: option.name,
        price: option.price,
        isActive: option.isActive,
        sortOrder: index,
      };
      if (option.id) {
        if (!known.has(option.id))
          throw errors.validation([{ path: `options.${index}.id` }]);
        keep.add(option.id);
        await tx.modifierOption.update({
          where: { id: option.id },
          data: { ...fields, ...(cost === undefined ? {} : { cost }) },
        });
      } else {
        await tx.modifierOption.create({
          data: {
            tenantId: auth.tenantId,
            groupId,
            ...fields,
            cost: cost ?? null,
          },
        });
      }
    }
    const removed = existing
      .filter((option) => !keep.has(option.id))
      .map((option) => option.id);
    if (removed.length)
      await tx.modifierOption.updateMany({
        where: { id: { in: removed } },
        data: { isActive: false },
      });
    await audit(tx, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: id ? 'menu.modifiers.update' : 'menu.modifiers.create',
      entityType: 'modifier_group',
      entityId: groupId,
    });
    return groupId;
  };

  router.post('/menu/modifier-groups', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(groupInput, req.body);
    const id = await db.$transaction((tx) =>
      writeGroup(tx, auth, input, null, req),
    );
    res.status(201).json({ id });
  });

  router.patch('/menu/modifier-groups/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(groupInput, req.body);
    await db.$transaction((tx) => writeGroup(tx, auth, input, id, req));
    res.json({ ok: true });
  });

  // Branch-specific prices and availability ("stop list"). A null price keeps the base price.
  /** Defines a set: the variant is sold at its own price and contains these items. */
  router.put('/menu/variants/:id/components', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const { components } = parse(
      z.object({
        components: z
          .array(
            z.object({
              variantId: z.uuid(),
              quantity: z.number().int().min(1).max(50),
            }),
          )
          .max(30),
      }),
      req.body,
    );
    await db.$transaction(async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!variant) throw errors.notFound();
      const ids = [...new Set(components.map((part) => part.variantId))];
      if (ids.includes(id)) throw errors.validation([{ path: 'components' }]);
      const found = await tx.productVariant.count({
        where: { tenantId: auth.tenantId, id: { in: ids } },
      });
      // Sets cannot contain other sets.
      const nested = await tx.comboComponent.count({
        where: { tenantId: auth.tenantId, variantId: { in: ids } },
      });
      if (found !== ids.length || nested > 0)
        throw errors.validation([{ path: 'components' }]);
      await tx.comboComponent.deleteMany({
        where: { tenantId: auth.tenantId, variantId: id },
      });
      await tx.comboComponent.createMany({
        data: components.map((part, index) => ({
          tenantId: auth.tenantId,
          variantId: id,
          componentVariantId: part.variantId,
          quantity: part.quantity,
          sortOrder: index,
        })),
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'menu.combo.update',
        entityType: 'product_variant',
        entityId: id,
        data: { components: components.length },
      });
    });
    services.events?.publish({ type: 'menu.changed', tenantId: auth.tenantId });
    res.json({ ok: true });
  });

  router.put('/menu/branch-prices', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid(),
        items: z
          .array(
            z.object({
              variantId: z.uuid(),
              price: amount.nullable(),
              isAvailable: z.boolean(),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    await db.$transaction(async (tx) => {
      const ids = [...new Set(input.items.map((item) => item.variantId))];
      const found = await tx.productVariant.count({
        where: { tenantId: auth.tenantId, id: { in: ids } },
      });
      if (found !== ids.length) throw errors.validation([{ path: 'items' }]);
      for (const item of input.items) {
        if (item.price === null && item.isAvailable) {
          await tx.branchVariantPrice.deleteMany({
            where: { branchId: branch.id, variantId: item.variantId },
          });
          continue;
        }
        await tx.branchVariantPrice.upsert({
          where: {
            branchId_variantId: {
              branchId: branch.id,
              variantId: item.variantId,
            },
          },
          create: {
            tenantId: auth.tenantId,
            branchId: branch.id,
            variantId: item.variantId,
            price: item.price,
            isAvailable: item.isAvailable,
          },
          update: { price: item.price, isAvailable: item.isAvailable },
        });
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'menu.branch_prices.update',
        data: input.items.map((item) => ({ ...item })),
      });
    });
    res.json({ ok: true });
  });

  return router;
}
