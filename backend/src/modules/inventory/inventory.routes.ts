import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAuth,
  requirePermission,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { syncStockAlert } from './alert-sync.js';
import {
  baseUnitLabels,
  defaultWarehouse,
  postMovement,
  ZERO,
} from './ledger.js';

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

/** Decimal quantity with at most 3 fractional digits, as number or string. */
const quantity = z
  .union([z.number(), z.string().trim()])
  .transform((value, ctx) => {
    const text = String(value);
    if (!/^-?\d{1,10}(\.\d{1,3})?$/.test(text)) {
      ctx.addIssue({ code: 'custom', message: 'quantity' });
      return z.NEVER;
    }
    return new Decimal(text);
  });
const positive = quantity.refine((value) => value.isPositive());
const amount = z.number().int().min(0).max(1_000_000_000);

const canSeeCost = (auth: AuthContext) =>
  (auth.permissions.has('inventory.manage') ||
    auth.permissions.has('finance.view')) &&
  auth.financial.cost;

const itemInput = z.object({
  name: z.string().trim().min(1).max(100),
  sku: z.string().trim().max(40).nullable().optional(),
  baseUnit: z.enum(['G', 'ML', 'PCS']),
  minStock: quantity
    .refine((value) => !value.isNegative())
    .default(new Decimal(0)),
  isActive: z.boolean().default(true),
  units: z
    .array(
      z.object({ name: z.string().trim().min(1).max(40), factor: positive }),
    )
    .max(10)
    .default([]),
});

/** Converts an entered quantity in a named unit to base units. */
async function toBase(
  tx: Tx,
  tenantId: string,
  stockItemId: string,
  unitName: string,
) {
  const item = await tx.stockItem.findFirst({
    where: { id: stockItemId, tenantId },
    include: { units: true },
  });
  if (!item) throw errors.validation([{ path: 'stockItemId' }]);
  if (unitName === baseUnitLabels[item.baseUnit])
    return { item, factor: new Decimal(1) };
  const unit = item.units.find((candidate) => candidate.name === unitName);
  if (!unit) throw new AppError(400, 'UNKNOWN_UNIT', 'unknownUnit');
  return { item, factor: new Decimal(unit.factor) };
}

export function inventoryRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const view = [requireAuth(), requirePermission('inventory.view')];
  const manage = [requireAuth(), requirePermission('inventory.manage')];
  const purchasing = [requireAuth(), requirePermission('purchasing.manage')];
  const allowNegative = async (tenantId: string) =>
    (await db.tenantProfile.findUnique({ where: { tenantId } }))
      ?.allowNegativeStock ?? true;

  // --- Stock items --------------------------------------------------------

  // Names and units only (no quantities or costs): lets kitchen staff build requests.
  router.get('/inventory/item-names', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('inventory.view') &&
      !auth.permissions.has('kitchen.access') &&
      !auth.permissions.has('operations.perform')
    )
      throw errors.forbidden();
    const items = await db.stockItem.findMany({
      where: { tenantId: auth.tenantId, isActive: true },
      orderBy: { name: 'asc' },
      include: { units: { select: { name: true } } },
    });
    res.json({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        unitLabel: baseUnitLabels[item.baseUnit],
        units: item.units.map((unit) => unit.name),
      })),
    });
  });

  router.get('/inventory/items', ...view, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const warehouse = await db.$transaction((tx) =>
      defaultWarehouse(tx, auth.tenantId, branch.id),
    );
    const items = await db.stockItem.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { name: 'asc' },
      include: {
        units: { orderBy: { factor: 'asc' } },
        balances: { where: { warehouseId: warehouse.id } },
      },
    });
    const costs = canSeeCost(auth);
    res.json({
      warehouse: { id: warehouse.id, name: warehouse.name },
      items: items.map((item) => {
        const balance = item.balances[0];
        const qty = new Decimal(balance?.quantity ?? 0);
        return {
          id: item.id,
          name: item.name,
          sku: item.sku,
          baseUnit: item.baseUnit,
          unitLabel: baseUnitLabels[item.baseUnit],
          minStock: item.minStock.toString(),
          isActive: item.isActive,
          units: item.units.map((unit) => ({
            name: unit.name,
            factor: unit.factor.toString(),
          })),
          quantity: qty.toString(),
          low: qty.lessThan(item.minStock),
          ...(costs
            ? {
                avgCost: new Decimal(balance?.avgCost ?? 0).toString(),
                value: qty.isPositive()
                  ? Math.round(qty.times(balance?.avgCost ?? 0).toNumber())
                  : 0,
              }
            : {}),
        };
      }),
    });
  });

  const writeItem = async (
    tx: Tx,
    auth: AuthContext,
    input: z.infer<typeof itemInput>,
    id: string | null,
  ) => {
    const data = {
      name: input.name,
      sku: input.sku ?? null,
      baseUnit: input.baseUnit,
      minStock: input.minStock,
      isActive: input.isActive,
    };
    let itemId = id;
    if (id) {
      const existing = await tx.stockItem.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!existing) throw errors.notFound();
      // Changing the base unit would silently reinterpret every recorded quantity.
      if (
        existing.baseUnit !== input.baseUnit &&
        (await tx.stockMovement.count({ where: { stockItemId: id } })) > 0
      )
        throw errors.conflict();
      await tx.stockItem.update({ where: { id }, data });
    } else
      itemId = (
        await tx.stockItem.create({
          data: { tenantId: auth.tenantId, ...data },
        })
      ).id;
    await tx.stockUnit.deleteMany({ where: { stockItemId: itemId! } });
    if (input.units.length)
      await tx.stockUnit.createMany({
        data: input.units.map((unit) => ({
          tenantId: auth.tenantId,
          stockItemId: itemId!,
          name: unit.name,
          factor: unit.factor,
        })),
      });
    // A new minimum (or switching the item off) changes whether it counts as short.
    const balances = await tx.stockBalance.findMany({
      where: { stockItemId: itemId! },
    });
    for (const balance of balances)
      await syncStockAlert(
        tx,
        {
          tenantId: auth.tenantId,
          warehouseId: balance.warehouseId,
          stockItemId: itemId!,
        },
        new Decimal(balance.quantity),
      );
    return itemId!;
  };

  router.post('/inventory/items', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(itemInput, req.body);
    try {
      const id = await db.$transaction((tx) =>
        writeItem(tx, auth, input, null),
      );
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'inventory.item.create',
        entityType: 'stock_item',
        entityId: id,
      });
      res.status(201).json({ id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/inventory/items/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(itemInput, req.body);
    try {
      await db.$transaction((tx) => writeItem(tx, auth, input, id));
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'inventory.item.update',
      entityType: 'stock_item',
      entityId: id,
    });
    res.json({ ok: true });
  });

  // --- Ledger -------------------------------------------------------------

  router.get('/inventory/movements', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        stockItemId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const warehouse = await db.$transaction((tx) =>
      defaultWarehouse(tx, auth.tenantId, branch.id),
    );
    const rows = await db.stockMovement.findMany({
      where: {
        tenantId: auth.tenantId,
        warehouseId: warehouse.id,
        ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
      include: { stockItem: { select: { name: true, baseUnit: true } } },
    });
    const costs = canSeeCost(auth);
    res.json({
      movements: rows.map((row) => ({
        id: row.id.toString(),
        type: row.type,
        stockItemId: row.stockItemId,
        stockItem: row.stockItem.name,
        unitLabel: baseUnitLabels[row.stockItem.baseUnit],
        quantity: row.quantity.toString(),
        balanceAfter: row.balanceAfter.toString(),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        reason: row.reason,
        createdAt: row.createdAt,
        ...(costs ? { unitCost: row.unitCost.toString() } : {}),
      })),
    });
  });

  // Waste/spoilage (removes stock) and manual corrections (signed).
  router.post('/inventory/adjustments', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        type: z.enum(['WASTE', 'ADJUSTMENT']),
        reason: z.string().trim().min(3).max(200),
        lines: z
          .array(z.object({ stockItemId: z.uuid(), quantity }))
          .min(1)
          .max(100),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const negative = await allowNegative(auth.tenantId);
    await db.$transaction(async (tx) => {
      const warehouse = await defaultWarehouse(tx, auth.tenantId, branch.id);
      for (const line of [...input.lines].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      )) {
        const item = await tx.stockItem.findFirst({
          where: { id: line.stockItemId, tenantId: auth.tenantId },
        });
        if (!item || line.quantity.isZero())
          throw errors.validation([{ path: 'lines' }]);
        // Waste quantities are entered as positive amounts removed from stock.
        const change =
          input.type === 'WASTE'
            ? line.quantity.abs().negated()
            : line.quantity;
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: warehouse.id,
          stockItemId: item.id,
          type: input.type,
          quantity: change,
          reason: input.reason,
          actorId: auth.userId,
          allowNegative: negative,
        });
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action:
          input.type === 'WASTE' ? 'inventory.waste' : 'inventory.adjustment',
        data: {
          reason: input.reason,
          lines: input.lines.map((line) => ({
            stockItemId: line.stockItemId,
            quantity: line.quantity.toString(),
          })),
        },
      });
    });
    res.status(201).json({ ok: true });
  });

  // Stocktake: records counted quantities; differences are posted to the ledger.
  router.post('/inventory/stocktakes', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        counts: z
          .array(
            z.object({
              stockItemId: z.uuid(),
              counted: quantity.refine((value) => !value.isNegative()),
            }),
          )
          .min(1)
          .max(500),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const result = await db.$transaction(async (tx) => {
      const warehouse = await defaultWarehouse(tx, auth.tenantId, branch.id);
      const reference = crypto.randomUUID();
      const differences: { stockItemId: string; difference: string }[] = [];
      for (const count of [...input.counts].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      )) {
        const item = await tx.stockItem.findFirst({
          where: { id: count.stockItemId, tenantId: auth.tenantId },
        });
        if (!item) throw errors.validation([{ path: 'counts' }]);
        await tx.$executeRaw`
          INSERT INTO stock_balances ("tenantId", "warehouseId", "stockItemId", quantity, "avgCost", "updatedAt")
          VALUES (${auth.tenantId}::uuid, ${warehouse.id}::uuid, ${item.id}::uuid, 0, 0, now()) ON CONFLICT DO NOTHING`;
        const rows = await tx.$queryRaw<{ quantity: Decimal }[]>`
          SELECT quantity FROM stock_balances WHERE "warehouseId" = ${warehouse.id}::uuid AND "stockItemId" = ${item.id}::uuid FOR UPDATE`;
        const difference = count.counted.minus(rows[0]!.quantity);
        if (difference.isZero()) continue;
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: warehouse.id,
          stockItemId: item.id,
          type: 'STOCKTAKE',
          quantity: difference,
          referenceType: 'stocktake',
          referenceId: reference,
          actorId: auth.userId,
          allowNegative: true,
        });
        differences.push({
          stockItemId: item.id,
          difference: difference.toString(),
        });
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'inventory.stocktake',
        entityType: 'stocktake',
        entityId: reference,
        data: { differences },
      });
      return { stocktakeId: reference, differences };
    });
    res.status(201).json(result);
  });

  // Transfer between branches' default warehouses at the source average cost.
  router.post('/inventory/transfers', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(
      z.object({
        fromBranchId: z.uuid().optional(),
        toBranchId: z.uuid(),
        lines: z
          .array(z.object({ stockItemId: z.uuid(), quantity: positive }))
          .min(1)
          .max(100),
        note: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    const from = await resolveBranch(db, auth, input.fromBranchId);
    const to = await resolveBranch(db, auth, input.toBranchId);
    if (from.id === to.id)
      throw new AppError(400, 'SAME_WAREHOUSE', 'sameWarehouse');
    const negative = await allowNegative(auth.tenantId);
    const reference = crypto.randomUUID();
    await db.$transaction(async (tx) => {
      const source = await defaultWarehouse(tx, auth.tenantId, from.id);
      const target = await defaultWarehouse(tx, auth.tenantId, to.id);
      for (const line of [...input.lines].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      )) {
        const item = await tx.stockItem.findFirst({
          where: { id: line.stockItemId, tenantId: auth.tenantId },
        });
        if (!item) throw errors.validation([{ path: 'lines' }]);
        const out = await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: source.id,
          stockItemId: item.id,
          type: 'TRANSFER_OUT',
          quantity: line.quantity.negated(),
          referenceType: 'transfer',
          referenceId: reference,
          reason: input.note ?? null,
          actorId: auth.userId,
          allowNegative: negative,
        });
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: target.id,
          stockItemId: item.id,
          type: 'TRANSFER_IN',
          quantity: line.quantity,
          unitCost: out ? new Decimal(out.unitCost) : ZERO,
          referenceType: 'transfer',
          referenceId: reference,
          reason: input.note ?? null,
          actorId: auth.userId,
          allowNegative: true,
        });
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: from.id,
        actorUserId: auth.userId,
        action: 'inventory.transfer',
        entityType: 'transfer',
        entityId: reference,
        data: {
          toBranchId: to.id,
          lines: input.lines.map((line) => ({
            stockItemId: line.stockItemId,
            quantity: line.quantity.toString(),
          })),
        },
      });
    });
    res.status(201).json({ transferId: reference });
  });

  // Low stock with a simple reorder suggestion (up to twice the minimum).
  router.get('/inventory/alerts', ...view, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const warehouse = await db.$transaction((tx) =>
      defaultWarehouse(tx, auth.tenantId, branch.id),
    );
    const items = await db.stockItem.findMany({
      where: { tenantId: auth.tenantId, isActive: true, minStock: { gt: 0 } },
      include: { balances: { where: { warehouseId: warehouse.id } } },
    });
    res.json({
      alerts: items
        .map((item) => ({
          item,
          qty: new Decimal(item.balances[0]?.quantity ?? 0),
        }))
        .filter(({ item, qty }) => qty.lessThan(item.minStock))
        .map(({ item, qty }) => ({
          stockItemId: item.id,
          name: item.name,
          unitLabel: baseUnitLabels[item.baseUnit],
          quantity: qty.toString(),
          minStock: item.minStock.toString(),
          suggestedOrder: Decimal.max(
            new Decimal(item.minStock).times(2).minus(qty),
            0,
          ).toString(),
        })),
    });
  });

  // --- Suppliers and purchases -------------------------------------------

  router.get('/suppliers', requireAuth(), async (_req, res) => {
    const auth = getAuth(res);
    if (
      !auth.permissions.has('purchasing.manage') &&
      !auth.permissions.has('inventory.view')
    )
      throw errors.forbidden();
    const [suppliers, purchased, paid] = await Promise.all([
      db.supplier.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { name: 'asc' },
      }),
      db.purchase.groupBy({
        by: ['supplierId'],
        where: { tenantId: auth.tenantId, status: 'RECEIVED' },
        _sum: { total: true },
      }),
      db.supplierPayment.groupBy({
        by: ['supplierId'],
        where: { tenantId: auth.tenantId },
        _sum: { amount: true },
      }),
    ]);
    const returned = await db.supplierReturn.groupBy({
      by: ['supplierId'],
      where: { tenantId: auth.tenantId },
      _sum: { total: true },
    });
    const showMoney =
      auth.permissions.has('purchasing.manage') ||
      auth.permissions.has('finance.view');
    res.json({
      suppliers: suppliers.map((supplier) => {
        const total =
          purchased.find((row) => row.supplierId === supplier.id)?._sum.total ??
          0;
        const payments =
          paid.find((row) => row.supplierId === supplier.id)?._sum.amount ?? 0;
        const returns =
          returned.find((row) => row.supplierId === supplier.id)?._sum.total ??
          0;
        return {
          id: supplier.id,
          name: supplier.name,
          phone: supplier.phone,
          taxId: supplier.taxId,
          note: supplier.note,
          isActive: supplier.isActive,
          ...(showMoney
            ? {
                purchased: total,
                paid: payments,
                returned: returns,
                debt: total - payments - returns,
              }
            : {}),
        };
      }),
    });
  });

  const supplierInput = z.object({
    name: z.string().trim().min(2).max(100),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/)
      .nullable()
      .optional(),
    taxId: z
      .string()
      .trim()
      .regex(/^\d{9,14}$/)
      .nullable()
      .optional(),
    note: z.string().trim().max(300).nullable().optional(),
    isActive: z.boolean().default(true),
  });

  router.post('/suppliers', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(supplierInput, req.body);
    try {
      const supplier = await db.supplier.create({
        data: {
          tenantId: auth.tenantId,
          name: input.name,
          phone: input.phone ?? null,
          taxId: input.taxId ?? null,
          note: input.note ?? null,
          isActive: input.isActive,
        },
      });
      await audit(db, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'supplier.create',
        entityType: 'supplier',
        entityId: supplier.id,
      });
      res.status(201).json({ id: supplier.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.patch('/suppliers/:id', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(supplierInput, req.body);
    try {
      const result = await db.supplier.updateMany({
        where: { id, tenantId: auth.tenantId },
        data: {
          name: input.name,
          phone: input.phone ?? null,
          taxId: input.taxId ?? null,
          note: input.note ?? null,
          isActive: input.isActive,
        },
      });
      if (result.count === 0) throw errors.notFound();
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
    res.json({ ok: true });
  });

  router.post('/suppliers/:id/payments', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        amount: amount.min(1),
        note: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    const supplier = await db.supplier.findFirst({
      where: { id, tenantId: auth.tenantId },
    });
    if (!supplier) throw errors.notFound();
    await db.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          tenantId: auth.tenantId,
          supplierId: id,
          amount: input.amount,
          note: input.note ?? null,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'supplier.payment',
        entityType: 'supplier',
        entityId: id,
        data: { paymentId: payment.id, amount: input.amount },
      });
    });
    res.status(201).json({ ok: true });
  });

  const purchaseInput = z.object({
    supplierId: z.uuid(),
    branchId: z.uuid().optional(),
    invoiceNo: z.string().trim().max(60).nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
    lines: z
      .array(
        z.object({
          stockItemId: z.uuid(),
          quantity: positive,
          unitName: z.string().trim().min(1).max(40),
          unitPrice: amount,
        }),
      )
      .min(1)
      .max(200),
  });

  const writeLines = async (
    tx: Tx,
    tenantId: string,
    purchaseId: string,
    lines: z.infer<typeof purchaseInput>['lines'],
  ) => {
    await tx.purchaseLine.deleteMany({ where: { purchaseId } });
    let total = 0;
    for (const line of lines) {
      const { factor } = await toBase(
        tx,
        tenantId,
        line.stockItemId,
        line.unitName,
      );
      const lineTotal = Math.round(
        line.quantity.times(line.unitPrice).toNumber(),
      );
      total += lineTotal;
      await tx.purchaseLine.create({
        data: {
          tenantId,
          purchaseId,
          stockItemId: line.stockItemId,
          quantity: line.quantity,
          unitName: line.unitName,
          factor,
          baseQuantity: line.quantity.times(factor),
          unitPrice: line.unitPrice,
          lineTotal,
        },
      });
    }
    await tx.purchase.update({ where: { id: purchaseId }, data: { total } });
  };

  router.get('/purchases', ...purchasing, async (_req, res) => {
    const auth = getAuth(res);
    const purchases = await db.purchase.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { supplier: { select: { name: true } }, lines: true },
    });
    res.json({
      purchases: purchases.map((purchase) => ({
        id: purchase.id,
        supplierId: purchase.supplierId,
        supplier: purchase.supplier.name,
        status: purchase.status,
        invoiceNo: purchase.invoiceNo,
        note: purchase.note,
        total: purchase.total,
        createdAt: purchase.createdAt,
        receivedAt: purchase.receivedAt,
        lines: purchase.lines.map((line) => ({
          stockItemId: line.stockItemId,
          quantity: line.quantity.toString(),
          unitName: line.unitName,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
      })),
    });
  });

  router.post('/purchases', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(purchaseInput, req.body);
    const branch = await resolveBranch(db, auth, input.branchId);
    const id = await db.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: {
          id: input.supplierId,
          tenantId: auth.tenantId,
          isActive: true,
        },
      });
      if (!supplier) throw errors.validation([{ path: 'supplierId' }]);
      const warehouse = await defaultWarehouse(tx, auth.tenantId, branch.id);
      const purchase = await tx.purchase.create({
        data: {
          tenantId: auth.tenantId,
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          invoiceNo: input.invoiceNo ?? null,
          note: input.note ?? null,
          createdById: auth.userId,
        },
      });
      await writeLines(tx, auth.tenantId, purchase.id, input.lines);
      return purchase.id;
    });
    res.status(201).json({ id });
  });

  router.patch('/purchases/:id', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(purchaseInput, req.body);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${id}::uuid FOR UPDATE`;
      const purchase = await tx.purchase.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!purchase) throw errors.notFound();
      if (purchase.status !== 'DRAFT')
        throw new AppError(409, 'PURCHASE_CLOSED', 'purchaseClosed');
      const supplier = await tx.supplier.findFirst({
        where: { id: input.supplierId, tenantId: auth.tenantId },
      });
      if (!supplier) throw errors.validation([{ path: 'supplierId' }]);
      await tx.purchase.update({
        where: { id },
        data: {
          supplierId: supplier.id,
          invoiceNo: input.invoiceNo ?? null,
          note: input.note ?? null,
        },
      });
      await writeLines(tx, auth.tenantId, id, input.lines);
    });
    res.json({ ok: true });
  });

  // Goods receipt: posts the purchase into the ledger and updates average costs.
  router.post('/purchases/:id/receive', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${id}::uuid FOR UPDATE`;
      const purchase = await tx.purchase.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { lines: true },
      });
      if (!purchase) throw errors.notFound();
      if (purchase.status !== 'DRAFT')
        throw new AppError(409, 'PURCHASE_CLOSED', 'purchaseClosed');
      const warehouse = await tx.warehouse.findFirstOrThrow({
        where: { id: purchase.warehouseId },
      });
      await resolveBranch(tx, auth, warehouse.branchId);
      for (const line of [...purchase.lines].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      ))
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: purchase.warehouseId,
          stockItemId: line.stockItemId,
          type: 'RECEIPT',
          quantity: new Decimal(line.baseQuantity),
          unitCost: new Decimal(line.unitPrice).dividedBy(line.factor),
          referenceType: 'purchase',
          referenceId: purchase.id,
          actorId: auth.userId,
          allowNegative: true,
        });
      await tx.purchase.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedAt: services.now?.() ?? new Date(),
          receivedById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: warehouse.branchId,
        actorUserId: auth.userId,
        action: 'purchase.receive',
        entityType: 'purchase',
        entityId: id,
        data: { total: purchase.total, supplierId: purchase.supplierId },
      });
    });
    res.json({ ok: true });
  });

  // Market shopping ("bozorlik"): a cash purchase entered after the trip, received at
  // once. Lines carry the amount actually paid; unknown products are created on the fly.
  const marketInput = z.object({
    branchId: z.uuid().optional(),
    supplierName: z.string().trim().min(1).max(100).default('Bozor'),
    note: z.string().trim().max(300).nullable().optional(),
    paid: z.boolean().default(true),
    // Approved stock requests this purchase fulfils.
    requestIds: z.array(z.uuid()).max(20).default([]),
    lines: z
      .array(
        z
          .object({
            stockItemId: z.uuid().optional(),
            newItem: z
              .object({
                name: z.string().trim().min(1).max(100),
                baseUnit: z.enum(['G', 'ML', 'PCS']),
              })
              .optional(),
            quantity: positive,
            unitName: z.string().trim().min(1).max(40),
            lineTotal: amount,
          })
          .refine((line) => !!line.stockItemId !== !!line.newItem),
      )
      .min(1)
      .max(200),
  });

  router.post('/purchases/market', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(marketInput, req.body);
    const branch = await resolveBranch(db, auth, input.branchId);
    const canCreateItems = auth.permissions.has('inventory.manage');
    const result = await db.$transaction(async (tx) => {
      const supplier =
        (await tx.supplier.findFirst({
          where: { tenantId: auth.tenantId, name: input.supplierName },
        })) ??
        (await tx.supplier.create({
          data: { tenantId: auth.tenantId, name: input.supplierName },
        }));
      const warehouse = await defaultWarehouse(tx, auth.tenantId, branch.id);
      const now = services.now?.() ?? new Date();
      const purchase = await tx.purchase.create({
        data: {
          tenantId: auth.tenantId,
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          note: input.note ?? null,
          createdById: auth.userId,
        },
      });
      let total = 0;
      const lines: {
        stockItemId: string;
        baseQuantity: Decimal;
        lineTotal: number;
      }[] = [];
      for (const line of input.lines) {
        let stockItemId = line.stockItemId;
        if (line.newItem) {
          const existing = await tx.stockItem.findFirst({
            where: {
              tenantId: auth.tenantId,
              name: { equals: line.newItem.name, mode: 'insensitive' },
            },
          });
          if (existing) stockItemId = existing.id;
          else {
            if (!canCreateItems) throw errors.forbidden();
            const big =
              line.newItem.baseUnit === 'G'
                ? [{ name: 'kg', factor: new Decimal(1000) }]
                : line.newItem.baseUnit === 'ML'
                  ? [{ name: 'l', factor: new Decimal(1000) }]
                  : [];
            stockItemId = await writeItem(
              tx,
              auth,
              {
                name: line.newItem.name,
                baseUnit: line.newItem.baseUnit,
                minStock: ZERO,
                isActive: true,
                units: big,
              },
              null,
            );
          }
        }
        const { factor } = await toBase(
          tx,
          auth.tenantId,
          stockItemId!,
          line.unitName,
        );
        const baseQuantity = line.quantity.times(factor);
        total += line.lineTotal;
        await tx.purchaseLine.create({
          data: {
            tenantId: auth.tenantId,
            purchaseId: purchase.id,
            stockItemId: stockItemId!,
            quantity: line.quantity,
            unitName: line.unitName,
            factor,
            baseQuantity,
            unitPrice: Math.round(
              new Decimal(line.lineTotal).dividedBy(line.quantity).toNumber(),
            ),
            lineTotal: line.lineTotal,
          },
        });
        lines.push({
          stockItemId: stockItemId!,
          baseQuantity,
          lineTotal: line.lineTotal,
        });
      }
      for (const line of [...lines].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      ))
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: warehouse.id,
          stockItemId: line.stockItemId,
          type: 'RECEIPT',
          quantity: line.baseQuantity,
          unitCost: new Decimal(line.lineTotal).dividedBy(line.baseQuantity),
          referenceType: 'purchase',
          referenceId: purchase.id,
          actorId: auth.userId,
          allowNegative: true,
        });
      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          total,
          status: 'RECEIVED',
          receivedAt: now,
          receivedById: auth.userId,
        },
      });
      if (input.paid && total > 0)
        await tx.supplierPayment.create({
          data: {
            tenantId: auth.tenantId,
            supplierId: supplier.id,
            amount: total,
            note: 'Bozorlik',
            createdById: auth.userId,
          },
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'purchase.market',
        entityType: 'purchase',
        entityId: purchase.id,
        data: { total, supplierId: supplier.id, paid: input.paid },
      });
      if (input.requestIds.length)
        await tx.stockRequest.updateMany({
          where: {
            id: { in: input.requestIds },
            tenantId: auth.tenantId,
            status: 'APPROVED',
          },
          data: { status: 'FULFILLED' },
        });
      return { id: purchase.id, total };
    });
    services.events?.publish({
      type: 'inventory.changed',
      tenantId: auth.tenantId,
    });
    res.status(201).json(result);
  });

  // --- Supplier returns -------------------------------------------------------

  router.post('/suppliers/:id/returns', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const supplierId = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        purchaseId: z.uuid().nullable().optional(),
        reason: z.string().trim().min(3).max(300),
        lines: z
          .array(
            z.object({
              stockItemId: z.uuid(),
              quantity: positive,
              unitName: z.string().trim().min(1).max(40),
              // Money credited by the supplier for this line.
              amount: amount,
            }),
          )
          .min(1)
          .max(100),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const created = await db.$transaction(async (tx) => {
      const supplier = await tx.supplier.findFirst({
        where: { id: supplierId, tenantId: auth.tenantId },
      });
      if (!supplier) throw errors.notFound();
      if (input.purchaseId) {
        const purchase = await tx.purchase.findFirst({
          where: {
            id: input.purchaseId,
            tenantId: auth.tenantId,
            supplierId,
            status: 'RECEIVED',
          },
        });
        if (!purchase) throw errors.validation([{ path: 'purchaseId' }]);
      }
      const warehouse = await defaultWarehouse(tx, auth.tenantId, branch.id);
      const lines = [];
      for (const line of [...input.lines].sort((a, b) =>
        a.stockItemId.localeCompare(b.stockItemId),
      )) {
        const { factor } = await toBase(
          tx,
          auth.tenantId,
          line.stockItemId,
          line.unitName,
        );
        const base = line.quantity.times(factor);
        // Cannot send back more than is in stock.
        await postMovement(tx, {
          tenantId: auth.tenantId,
          warehouseId: warehouse.id,
          stockItemId: line.stockItemId,
          type: 'SUPPLIER_RETURN',
          quantity: base.negated(),
          referenceType: 'supplier_return',
          referenceId: supplierId,
          actorId: auth.userId,
          allowNegative: false,
        });
        lines.push({
          stockItemId: line.stockItemId,
          quantity: base.toString(),
          amount: line.amount,
        });
      }
      const total = lines.reduce((sum, line) => sum + line.amount, 0);
      const row = await tx.supplierReturn.create({
        data: {
          tenantId: auth.tenantId,
          supplierId,
          purchaseId: input.purchaseId ?? null,
          warehouseId: warehouse.id,
          lines,
          total,
          reason: input.reason,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'supplier.return',
        entityType: 'supplier',
        entityId: supplierId,
        data: { returnId: row.id, total, reason: input.reason },
      });
      return row;
    });
    services.events?.publish({
      type: 'inventory.changed',
      tenantId: auth.tenantId,
    });
    res.status(201).json({ id: created.id, total: created.total });
  });

  router.get('/suppliers/:id/returns', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const supplierId = parse(z.uuid(), req.params.id);
    const returns = await db.supplierReturn.findMany({
      where: { tenantId: auth.tenantId, supplierId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ returns });
  });

  // --- Stock requests (staff ask, manager approves, purchase fulfils) ----------

  const requestItems = z
    .array(
      z.object({
        stockItemId: z.uuid(),
        quantity: positive,
        unitName: z.string().trim().min(1).max(40),
      }),
    )
    .min(1)
    .max(50);

  router.post('/inventory/requests', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (
      auth.tenantKind !== 'BUSINESS' ||
      !(
        auth.permissions.has('inventory.view') ||
        auth.permissions.has('kitchen.access') ||
        auth.permissions.has('operations.perform')
      )
    )
      throw errors.forbidden();
    const input = parse(
      z.object({
        branchId: z.uuid().optional(),
        items: requestItems,
        note: z.string().trim().max(300).nullable().optional(),
      }),
      req.body,
    );
    const branch = await resolveBranch(db, auth, input.branchId);
    const row = await db.$transaction(async (tx) => {
      for (const item of input.items)
        await toBase(tx, auth.tenantId, item.stockItemId, item.unitName);
      return tx.stockRequest.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          items: input.items.map((item) => ({
            ...item,
            quantity: item.quantity.toString(),
          })),
          note: input.note ?? null,
          requestedById: auth.userId,
        },
      });
    });
    services.events?.publish({
      type: 'inventory.changed',
      tenantId: auth.tenantId,
    });
    res.status(201).json({ id: row.id });
  });

  // Low-stock alerts turned into one request (shortfall up to twice the minimum).
  router.post('/inventory/requests/from-alerts', ...view, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.body ?? {},
    );
    const branch = await resolveBranch(db, auth, branchId);
    const warehouse = await db.$transaction((tx) =>
      defaultWarehouse(tx, auth.tenantId, branch.id),
    );
    const items = await db.stockItem.findMany({
      where: { tenantId: auth.tenantId, isActive: true, minStock: { gt: 0 } },
      include: { balances: { where: { warehouseId: warehouse.id } } },
    });
    const low = items
      .map((item) => {
        const quantity = new Decimal(item.balances[0]?.quantity ?? 0);
        const need = new Decimal(item.minStock).times(2).minus(quantity);
        return quantity.lessThan(item.minStock) && need.isPositive()
          ? {
              stockItemId: item.id,
              quantity: need.toDecimalPlaces(3).toString(),
              unitName: baseUnitLabels[item.baseUnit],
            }
          : null;
      })
      .filter((item) => item !== null);
    if (!low.length) {
      res.json({ id: null, items: 0 });
      return;
    }
    const row = await db.stockRequest.create({
      data: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        items: low,
        note: 'Kam qoldiqlar',
        requestedById: auth.userId,
      },
    });
    res.status(201).json({ id: row.id, items: low.length });
  });

  router.get('/inventory/requests', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
    const { status, branchId } = parse(
      z.object({
        status: z
          .enum(['PENDING', 'APPROVED', 'REJECTED', 'FULFILLED'])
          .optional(),
        branchId: z.uuid().optional(),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const managers =
      auth.permissions.has('inventory.manage') ||
      auth.permissions.has('purchasing.manage');
    const rows = await db.stockRequest.findMany({
      where: {
        tenantId: auth.tenantId,
        branchId: branch.id,
        ...(status ? { status } : {}),
        // Staff see their own requests; managers see all.
        ...(managers ? {} : { requestedById: auth.userId }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const people = await db.user.findMany({
      where: {
        tenantId: auth.tenantId,
        id: { in: rows.map((row) => row.requestedById) },
      },
      select: { id: true, displayName: true },
    });
    res.json({
      requests: rows.map((row) => ({
        ...row,
        requestedBy:
          people.find((person) => person.id === row.requestedById)
            ?.displayName ?? null,
      })),
    });
  });

  router.post(
    '/inventory/requests/:id/decide',
    requireAuth(),
    async (req, res) => {
      const auth = getAuth(res);
      if (
        !auth.permissions.has('inventory.manage') &&
        !auth.permissions.has('purchasing.manage')
      )
        throw errors.forbidden();
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          decision: z.enum(['APPROVED', 'REJECTED', 'FULFILLED']),
          comment: z.string().trim().max(300).nullable().optional(),
        }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM stock_requests WHERE id = ${id}::uuid AND "tenantId" = ${auth.tenantId}::uuid FOR UPDATE`;
        if (!rows.length) throw errors.notFound();
        const row = await tx.stockRequest.findUniqueOrThrow({ where: { id } });
        await resolveBranch(tx, auth, row.branchId);
        const allowed =
          input.decision === 'FULFILLED'
            ? row.status === 'APPROVED'
            : row.status === 'PENDING';
        if (!allowed) throw errors.conflict();
        if (input.decision !== 'FULFILLED' && row.requestedById === auth.userId)
          throw new AppError(409, 'SELF_APPROVAL', 'selfApproval');
        await tx.stockRequest.update({
          where: { id },
          data: {
            status: input.decision,
            ...(input.decision === 'FULFILLED'
              ? {}
              : {
                  decidedById: auth.userId,
                  decidedAt: services.now?.() ?? new Date(),
                  comment: input.comment ?? null,
                }),
          },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: row.branchId,
          actorUserId: auth.userId,
          action: `stock.request.${input.decision.toLowerCase()}`,
          entityType: 'stock_request',
          entityId: id,
        });
      });
      services.events?.publish({
        type: 'inventory.changed',
        tenantId: auth.tenantId,
      });
      res.json({ ok: true });
    },
  );

  router.post('/purchases/:id/cancel', ...purchasing, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const result = await db.purchase.updateMany({
      where: { id, tenantId: auth.tenantId, status: 'DRAFT' },
      data: { status: 'CANCELLED' },
    });
    if (result.count === 0)
      throw new AppError(409, 'PURCHASE_CLOSED', 'purchaseClosed');
    await audit(db, req, {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      action: 'purchase.cancel',
      entityType: 'purchase',
      entityId: id,
    });
    res.json({ ok: true });
  });

  // --- Recipes ------------------------------------------------------------

  const recipeAccess = (auth: AuthContext) => {
    if (
      !auth.permissions.has('menu.manage') &&
      !auth.permissions.has('inventory.manage')
    )
      throw errors.forbidden();
  };

  router.get('/recipes/:variantId', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    recipeAccess(auth);
    const variantId = parse(z.uuid(), req.params.variantId);
    const variant = await db.productVariant.findFirst({
      where: { id: variantId, tenantId: auth.tenantId },
    });
    if (!variant) throw errors.notFound();
    const branchId = auth.activeBranchId;
    const warehouse = branchId
      ? await db.$transaction((tx) =>
          defaultWarehouse(tx, auth.tenantId, branchId),
        )
      : null;
    const lines = await db.recipeLine.findMany({
      where: { variantId },
      include: {
        stockItem: {
          include: {
            balances: warehouse
              ? { where: { warehouseId: warehouse.id } }
              : false,
          },
        },
      },
    });
    const costs = canSeeCost(auth) || auth.permissions.has('menu.cost.view');
    let recipeCost = ZERO;
    const result = lines.map((line) => {
      const avg = new Decimal(line.stockItem.balances?.[0]?.avgCost ?? 0);
      recipeCost = recipeCost.plus(avg.times(line.quantity));
      return {
        stockItemId: line.stockItemId,
        name: line.stockItem.name,
        unitLabel: baseUnitLabels[line.stockItem.baseUnit],
        quantity: line.quantity.toString(),
      };
    });
    res.json({
      variantId,
      lines: result,
      ...(costs ? { recipeCost: Math.round(recipeCost.toNumber()) } : {}),
    });
  });

  router.put('/recipes/:variantId', requireAuth(), async (req, res) => {
    const auth = getAuth(res);
    recipeAccess(auth);
    const variantId = parse(z.uuid(), req.params.variantId);
    const input = parse(
      z.object({
        lines: z
          .array(z.object({ stockItemId: z.uuid(), quantity: positive }))
          .max(50),
      }),
      req.body,
    );
    if (
      new Set(input.lines.map((line) => line.stockItemId)).size !==
      input.lines.length
    )
      throw errors.validation([{ path: 'lines' }]);
    await db.$transaction(async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, tenantId: auth.tenantId },
      });
      if (!variant) throw errors.notFound();
      const found = await tx.stockItem.count({
        where: {
          tenantId: auth.tenantId,
          id: { in: input.lines.map((line) => line.stockItemId) },
        },
      });
      if (found !== input.lines.length)
        throw errors.validation([{ path: 'lines' }]);
      await tx.recipeLine.deleteMany({ where: { variantId } });
      if (input.lines.length)
        await tx.recipeLine.createMany({
          data: input.lines.map((line) => ({
            tenantId: auth.tenantId,
            variantId,
            stockItemId: line.stockItemId,
            quantity: line.quantity,
          })),
        });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'recipe.update',
        entityType: 'product_variant',
        entityId: variantId,
        data: {
          lines: input.lines.map((line) => ({
            stockItemId: line.stockItemId,
            quantity: line.quantity.toString(),
          })),
        },
      });
    });
    res.json({ ok: true });
  });

  return router;
}
