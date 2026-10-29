import { z } from 'zod';
import type { Db } from '../../db.js';
import type { BackupStore } from '../../lib/backup-store.js';
import { AppError } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import { orderSettingsOf, orderSettingsSchema } from '../orders/settings.js';
import {
  ENFORCED_TYPES,
  loadPrintRules,
  printRulesSchema,
  assertRulePrinters,
  RECEIPT_TYPES,
  testPage,
} from '../../printing/rules.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Operations the SUPER_OWNER may run on a restaurant (Owner → Restoran boshqaruvi).
 * The same executor serves restaurants hosted on the central server (run at once) and
 * restaurants on their own computer (run there when the signed heartbeat delivers it).
 *
 * Reads return snapshots without secrets (no password/PIN hashes, tokens or QR tokens).
 * Writes are small, explicit and audited as Owner actions; history (orders, payments,
 * stock movements) is never rewritten.
 */

const uuid = z.uuid();
const backupName = z.string().regex(/^[0-9A-Za-z.-]{10,80}$/);

export const OP_PAYLOADS = {
  'snapshot.menu': z.object({}),
  'snapshot.staff': z.object({}),
  'snapshot.floor': z.object({}),
  'snapshot.settings': z.object({}),
  'snapshot.inventory': z.object({}),
  'snapshot.reports': z.object({
    days: z.number().int().min(1).max(31).default(7),
  }),
  'menu.product.visibility': z.object({
    productId: uuid,
    isActive: z.boolean(),
  }),
  'menu.variant.price': z.object({
    variantId: uuid,
    price: z.number().int().min(0).max(1_000_000_000),
  }),
  'menu.category.visibility': z.object({
    categoryId: uuid,
    isActive: z.boolean(),
  }),
  'staff.status': z.object({
    userId: uuid,
    status: z.enum(['ACTIVE', 'DISABLED']),
  }),
  'floor.room': z.object({
    roomId: uuid,
    name: z.string().trim().min(1).max(60).optional(),
    isActive: z.boolean().optional(),
    kind: z.enum(['HALL', 'VIP', 'BAR']).optional(),
  }),
  'floor.table': z.object({
    tableId: uuid,
    name: z.string().trim().min(1).max(40).optional(),
    isActive: z.boolean().optional(),
  }),
  'settings.orders': orderSettingsSchema.partial(),
  'snapshot.printers': z.object({}),
  'printer.update': z.object({
    printerId: uuid,
    name: z.string().trim().min(1).max(60).optional(),
    isActive: z.boolean().optional(),
    paperWidth: z.number().int().min(40).max(112).optional(),
    stationId: uuid.nullable().optional(),
    fallbackPrinterId: uuid.nullable().optional(),
  }),
  'printer.test': z.object({ printerId: uuid }),
  'print.rules': printRulesSchema,
  'inventory.minStock': z.object({
    stockItemId: uuid,
    minStock: z.number().min(0).max(1_000_000_000),
  }),
  // Ma'lumotlarni tiklash: backups of a restaurant computer.
  'snapshot.backups': z.object({}),
  'backup.create': z.object({}),
  'backup.verify': z.object({ name: backupName }),
  'backup.restore': z.object({
    name: backupName,
    confirm: z.literal('TIKLASH'),
  }),
  'backup.rollback': z.object({
    database: z.string().regex(/^fastfood_before_[0-9]{8,20}$/),
    confirm: z.literal('TIKLASH'),
  }),
} as const;
/** Operations after which the restaurant server restarts (database swap). */
export const RESTART_OPS = ['backup.restore', 'backup.rollback'];
export type OpKind = keyof typeof OP_PAYLOADS;
export const OP_KINDS = Object.keys(OP_PAYLOADS) as OpKind[];
export const isSnapshot = (kind: string) => kind.startsWith('snapshot.');

const notFound = () => new AppError(404, 'NOT_FOUND', 'notFound');

/** Only the fields actually given (an optional field left out stays unchanged). */
const given = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [K in keyof T]-?: Exclude<T[K], undefined> };

/** Runs one operation for the restaurant's tenant; returns its (JSON) result. */
export async function executeOp(
  db: Db,
  tenantId: string,
  kind: string,
  rawPayload: unknown,
  // Only the restaurant computer has backups (hosted restaurants: Render's own).
  local: { backups?: BackupStore | undefined } = {},
): Promise<unknown> {
  const backups = () => {
    if (!local.backups)
      throw new AppError(409, 'BACKUP_UNAVAILABLE', 'backupUnavailable');
    return local.backups;
  };
  if (!(kind in OP_PAYLOADS))
    throw new AppError(400, 'OP_UNKNOWN', 'validation');
  const owned = { tenantId };
  const ownerAudit = (
    action: string,
    entityType: string,
    entityId: string,
    data?: object,
  ) =>
    audit(db, null, {
      tenantId,
      action,
      entityType,
      entityId,
      data: { by: 'owner', ...(data ?? {}) },
    });

  switch (kind as OpKind) {
    case 'snapshot.menu': {
      OP_PAYLOADS['snapshot.menu'].parse(rawPayload ?? {});
      const [categories, products] = await Promise.all([
        db.menuCategory.findMany({
          where: owned,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            parentId: true,
            isActive: true,
            stationId: true,
          },
        }),
        db.product.findMany({
          where: { ...owned, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            categoryId: true,
            isActive: true,
            imageUrl: true,
            variants: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                name: true,
                price: true,
                cost: true,
                isActive: true,
              },
            },
          },
        }),
      ]);
      return { categories, products };
    }
    case 'snapshot.staff': {
      OP_PAYLOADS['snapshot.staff'].parse(rawPayload ?? {});
      const users = await db.user.findMany({
        where: { ...owned, deletedAt: null },
        orderBy: { displayName: 'asc' },
        select: {
          id: true,
          username: true,
          displayName: true,
          status: true,
          lastLoginAt: true,
          pinHash: true,
          roles: {
            select: { role: { select: { name: true, systemKey: true } } },
          },
        },
      });
      // Only whether a PIN exists — never the hash.
      return {
        users: users.map(({ pinHash, roles, ...user }) => ({
          ...user,
          hasPin: pinHash !== null,
          roles: roles.map((row) => row.role.name),
        })),
      };
    }
    case 'snapshot.floor': {
      OP_PAYLOADS['snapshot.floor'].parse(rawPayload ?? {});
      const rooms = await db.room.findMany({
        where: owned,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          kind: true,
          isActive: true,
          branch: { select: { name: true } },
          tables: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: { id: true, name: true, seats: true, isActive: true },
          },
        },
      });
      return { rooms };
    }
    case 'snapshot.settings': {
      OP_PAYLOADS['snapshot.settings'].parse(rawPayload ?? {});
      const [profile, printers, stations] = await Promise.all([
        db.tenantProfile.findUnique({
          where: owned,
          select: {
            orderSettings: true,
            serviceChargeBp: true,
            publicOrdering: true,
            workflowVersion: true,
          },
        }),
        db.printer.findMany({
          where: owned,
          select: {
            id: true,
            name: true,
            kind: true,
            host: true,
            port: true,
            paperWidth: true,
            isActive: true,
            station: { select: { name: true } },
          },
        }),
        db.kitchenStation.findMany({
          where: owned,
          select: { id: true, name: true, isActive: true },
        }),
      ]);
      return {
        orderSettings: orderSettingsOf(profile?.orderSettings),
        serviceChargeBp: profile?.serviceChargeBp ?? 0,
        publicOrdering: profile?.publicOrdering ?? false,
        workflowVersion: profile?.workflowVersion ?? 0,
        printers,
        stations,
      };
    }
    case 'snapshot.inventory': {
      OP_PAYLOADS['snapshot.inventory'].parse(rawPayload ?? {});
      const items = await db.stockItem.findMany({
        where: { ...owned, isActive: true },
        orderBy: { name: 'asc' },
        take: 1000,
        select: {
          id: true,
          name: true,
          baseUnit: true,
          minStock: true,
          balances: { select: { quantity: true } },
        },
      });
      return {
        items: items.map((item) => {
          const quantity = item.balances.reduce(
            (sum, balance) => sum + Number(balance.quantity),
            0,
          );
          return {
            id: item.id,
            name: item.name,
            unit: item.baseUnit,
            quantity,
            minStock: Number(item.minStock),
            low: quantity < Number(item.minStock),
          };
        }),
      };
    }
    case 'snapshot.reports': {
      const payload = OP_PAYLOADS['snapshot.reports'].parse(rawPayload ?? {});
      const since = new Date(Date.now() - payload.days * 86_400_000);
      const orders = await db.order.findMany({
        where: {
          ...owned,
          createdAt: { gte: since },
          status: { not: 'CANCELLED' },
        },
        select: {
          total: true,
          paidTotal: true,
          refundedTotal: true,
          status: true,
          createdAt: true,
        },
      });
      const byDay = new Map<
        string,
        { orders: number; total: number; paid: number }
      >();
      for (const order of orders) {
        const day = order.createdAt.toISOString().slice(0, 10);
        const row = byDay.get(day) ?? { orders: 0, total: 0, paid: 0 };
        row.orders += 1;
        row.total += order.total;
        row.paid += order.paidTotal - order.refundedTotal;
        byDay.set(day, row);
      }
      return {
        days: [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, row]) => ({ day, ...row })),
        open: orders.filter((order) => order.status !== 'COMPLETED').length,
      };
    }
    case 'menu.product.visibility': {
      const payload = OP_PAYLOADS['menu.product.visibility'].parse(
        rawPayload ?? {},
      );
      const result = await db.product.updateMany({
        where: { ...owned, id: payload.productId, deletedAt: null },
        data: { isActive: payload.isActive, version: { increment: 1 } },
      });
      if (result.count === 0) throw notFound();
      await ownerAudit(
        payload.isActive ? 'menu.product.show' : 'menu.product.hide',
        'product',
        payload.productId,
      );
      return { ok: true };
    }
    case 'menu.variant.price': {
      const payload = OP_PAYLOADS['menu.variant.price'].parse(rawPayload ?? {});
      // Orders keep their own prices; only new orders use the new one.
      const variant = await db.productVariant.findFirst({
        where: { ...owned, id: payload.variantId },
        select: { price: true },
      });
      if (!variant) throw notFound();
      await db.productVariant.update({
        where: { id: payload.variantId },
        data: { price: payload.price },
      });
      await ownerAudit(
        'menu.variant.price',
        'product_variant',
        payload.variantId,
        {
          from: variant.price,
          to: payload.price,
        },
      );
      return { ok: true };
    }
    case 'menu.category.visibility': {
      const payload = OP_PAYLOADS['menu.category.visibility'].parse(
        rawPayload ?? {},
      );
      const result = await db.menuCategory.updateMany({
        where: { ...owned, id: payload.categoryId },
        data: { isActive: payload.isActive },
      });
      if (result.count === 0) throw notFound();
      await ownerAudit(
        'menu.category.update',
        'menu_category',
        payload.categoryId,
        {
          isActive: payload.isActive,
        },
      );
      return { ok: true };
    }
    case 'staff.status': {
      const payload = OP_PAYLOADS['staff.status'].parse(rawPayload ?? {});
      const result = await db.user.updateMany({
        where: { ...owned, id: payload.userId, deletedAt: null },
        data: { status: payload.status },
      });
      if (result.count === 0) throw notFound();
      // A disabled employee's sessions end at once.
      if (payload.status === 'DISABLED')
        await db.session.updateMany({
          where: { userId: payload.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokeReason: 'owner_disabled' },
        });
      await ownerAudit('user.status', 'user', payload.userId, {
        status: payload.status,
      });
      return { ok: true };
    }
    case 'floor.room': {
      const payload = OP_PAYLOADS['floor.room'].parse(rawPayload ?? {});
      const { roomId, ...data } = payload;
      const result = await db.room.updateMany({
        where: { ...owned, id: roomId },
        data: given(data),
      });
      if (result.count === 0) throw notFound();
      await ownerAudit('room.update', 'room', roomId, data);
      return { ok: true };
    }
    case 'floor.table': {
      const payload = OP_PAYLOADS['floor.table'].parse(rawPayload ?? {});
      const { tableId, ...data } = payload;
      const result = await db.diningTable.updateMany({
        where: { ...owned, id: tableId },
        data: given(data),
      });
      if (result.count === 0) throw notFound();
      await ownerAudit('table.update', 'dining_table', tableId, data);
      return { ok: true };
    }
    case 'settings.orders': {
      const payload = OP_PAYLOADS['settings.orders'].parse(rawPayload ?? {});
      const profile = await db.tenantProfile.findUnique({
        where: owned,
        select: { orderSettings: true },
      });
      const next = { ...orderSettingsOf(profile?.orderSettings), ...payload };
      await db.tenantProfile.upsert({
        where: owned,
        create: { tenantId, orderSettings: next },
        update: { orderSettings: next },
      });
      await ownerAudit('settings.orders', 'tenant_profile', tenantId, payload);
      return { ok: true };
    }
    case 'snapshot.printers': {
      OP_PAYLOADS['snapshot.printers'].parse(rawPayload ?? {});
      const since = new Date(Date.now() - 86_400_000);
      const [printers, stations, rules] = await Promise.all([
        db.printer.findMany({
          where: owned,
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            kind: true,
            host: true,
            port: true,
            paperWidth: true,
            isActive: true,
            stationId: true,
            fallbackPrinterId: true,
            branchId: true,
          },
        }),
        db.kitchenStation.findMany({
          where: owned,
          select: { id: true, name: true, isActive: true },
        }),
        loadPrintRules(db, tenantId),
      ]);
      const withStatus = await Promise.all(
        printers.map(async (printer) => {
          const [last, failed, unknown, pending] = await Promise.all([
            db.printJob.findFirst({
              where: { printerId: printer.id },
              orderBy: { createdAt: 'desc' },
              select: { status: true, createdAt: true, lastError: true },
            }),
            db.printJob.count({
              where: {
                printerId: printer.id,
                status: 'FAILED',
                createdAt: { gte: since },
              },
            }),
            db.printJob.count({
              where: {
                printerId: printer.id,
                status: 'UNKNOWN',
                createdAt: { gte: since },
              },
            }),
            db.printJob.count({
              where: {
                printerId: printer.id,
                status: { in: ['PENDING', 'PRINTING'] },
              },
            }),
          ]);
          return {
            ...printer,
            lastJob: last,
            failed24h: failed,
            unknown24h: unknown,
            pending,
          };
        }),
      );
      // Two active printers on one address print each other's tickets.
      const seen = new Map<string, number>();
      for (const printer of printers.filter((p) => p.isActive))
        seen.set(
          `${printer.host}:${printer.port}`,
          (seen.get(`${printer.host}:${printer.port}`) ?? 0) + 1,
        );
      return {
        printers: withStatus.map((printer) => ({
          ...printer,
          duplicateAddress:
            (seen.get(`${printer.host}:${printer.port}`) ?? 0) > 1,
        })),
        stations,
        rules,
        types: RECEIPT_TYPES,
        enforced: ENFORCED_TYPES,
      };
    }
    case 'printer.update': {
      const { printerId, ...data } = OP_PAYLOADS['printer.update'].parse(
        rawPayload ?? {},
      );
      const printer = await db.printer.findFirst({
        where: { ...owned, id: printerId },
      });
      if (!printer) throw notFound();
      if (data.stationId) {
        const station = await db.kitchenStation.findFirst({
          where: { ...owned, id: data.stationId },
        });
        if (!station) throw notFound();
      }
      if (data.fallbackPrinterId) {
        const fallback = await db.printer.findFirst({
          where: {
            ...owned,
            id: data.fallbackPrinterId,
            NOT: { id: printerId },
          },
        });
        if (!fallback) throw notFound();
      }
      await db.printer.update({ where: { id: printerId }, data: given(data) });
      await ownerAudit('printer.update', 'printer', printerId, given(data));
      return { ok: true };
    }
    case 'printer.test': {
      const { printerId } = OP_PAYLOADS['printer.test'].parse(rawPayload ?? {});
      const printer = await db.printer.findFirst({
        where: { ...owned, id: printerId },
        include: { station: true },
      });
      if (!printer) throw notFound();
      const job = await db.printJob.create({
        data: {
          tenantId,
          printerId,
          kind: printer.kind,
          payload: testPage(printer),
        },
      });
      await ownerAudit('printer.test', 'printer', printerId);
      return { jobId: job.id };
    }
    case 'print.rules': {
      const rules = OP_PAYLOADS['print.rules'].parse(rawPayload ?? {});
      await assertRulePrinters(db, tenantId, rules);
      await db.tenantProfile.upsert({
        where: owned,
        create: { tenantId, printRules: rules as Prisma.InputJsonValue },
        update: { printRules: rules as Prisma.InputJsonValue },
      });
      await ownerAudit('print.rules', 'tenant_profile', tenantId, {
        types: Object.keys(rules),
      });
      return { ok: true };
    }
    case 'inventory.minStock': {
      const payload = OP_PAYLOADS['inventory.minStock'].parse(rawPayload ?? {});
      const result = await db.stockItem.updateMany({
        where: { ...owned, id: payload.stockItemId },
        data: { minStock: payload.minStock },
      });
      if (result.count === 0) throw notFound();
      await ownerAudit(
        'inventory.min_stock',
        'stock_item',
        payload.stockItemId,
        {
          minStock: payload.minStock,
        },
      );
      return { ok: true };
    }
    case 'snapshot.backups': {
      OP_PAYLOADS['snapshot.backups'].parse(rawPayload ?? {});
      if (!local.backups)
        return {
          available: false,
          canRestore: false,
          backups: [],
          kept: [],
          status: null,
        };
      const [list, kept, status] = await Promise.all([
        local.backups.list(),
        local.backups.keptDatabases().catch(() => []),
        local.backups.status(),
      ]);
      return {
        available: true,
        canRestore: local.backups.canRestore,
        backups: list,
        kept,
        status,
      };
    }
    case 'backup.create': {
      OP_PAYLOADS['backup.create'].parse(rawPayload ?? {});
      const created = await backups().create('manual');
      await ownerAudit('backup.create', 'backup', created.name);
      return created;
    }
    case 'backup.verify': {
      const payload = OP_PAYLOADS['backup.verify'].parse(rawPayload);
      const result = await backups().verify(payload.name);
      await ownerAudit('backup.verify', 'backup', payload.name, {
        ok: result.ok,
      });
      return result;
    }
    case 'backup.restore': {
      const payload = OP_PAYLOADS['backup.restore'].parse(rawPayload);
      const prepared = await backups().prepareRestore(payload.name);
      await ownerAudit('backup.restore', 'backup', payload.name, prepared);
      return { ...prepared, restarting: true };
    }
    case 'backup.rollback': {
      const payload = OP_PAYLOADS['backup.rollback'].parse(rawPayload);
      const prepared = await backups().prepareRollback(payload.database);
      await ownerAudit('backup.rollback', 'backup', payload.database);
      return { ...prepared, restarting: true };
    }
  }
}
