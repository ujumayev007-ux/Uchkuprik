import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import {
  AppError,
  errors,
  isUniqueViolation,
  parse,
} from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  canAccessBranch,
  getAuth,
  requireAuth,
  requirePermission,
  type AuthContext,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { notifyIncident } from '../notifications/hooks.js';

const DAY = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);
const money = z.number().int().min(0).max(1_000_000_000);

// Repairs costing at least this much need an approval before they are closed.
export const DEFAULT_REPAIR_APPROVAL_THRESHOLD = 1_000_000;

function staffOnly() {
  return (_req: unknown, res: Response, next: () => void) => {
    const auth = getAuth(res);
    const allowed = [
      'operations.perform',
      'operations.manage',
      'assets.manage',
    ];
    if (
      auth.tenantKind !== 'BUSINESS' ||
      !allowed.some((key) => auth.permissions.has(key as never))
    )
      throw errors.forbidden();
    next();
  };
}

async function loadAsset(tx: Tx, auth: AuthContext, id: string) {
  const asset = await tx.asset.findFirst({
    where: { id, tenantId: auth.tenantId },
  });
  if (!asset || !canAccessBranch(auth, asset.branchId)) throw errors.notFound();
  return asset;
}

async function event(
  tx: Tx,
  asset: { id: string; tenantId: string },
  type: string,
  actorId: string | null,
  extra: { note?: string | null; cost?: number | null; passed?: boolean } = {},
) {
  await tx.assetEvent.create({
    data: {
      tenantId: asset.tenantId,
      assetId: asset.id,
      type,
      actorId,
      note: extra.note ?? null,
      cost: extra.cost ?? null,
      passed: extra.passed ?? null,
    },
  });
}

/**
 * Creates an operations task for every due maintenance plan that has no open task
 * yet (built-in automation). Idempotent; run hourly and on demand.
 */
export async function runMaintenanceScheduler(
  services: Services,
  tenantId?: string,
) {
  const now = services.now?.() ?? new Date();
  const due = await services.db.maintenancePlan.findMany({
    where: {
      isActive: true,
      nextDueAt: { lte: now },
      asset: { status: { not: 'RETIRED' } },
      tasks: { none: { status: 'OPEN' } },
      ...(tenantId ? { tenantId } : {}),
    },
    include: { asset: true },
    take: 500,
  });
  for (const plan of due)
    await services.db.opsTask.create({
      data: {
        tenantId: plan.tenantId,
        branchId: plan.asset.branchId,
        title: `Texnik xizmat: ${plan.asset.name} — ${plan.title}`,
        description: `Inventar raqami: ${plan.asset.tag}`,
        dueAt: new Date(plan.nextDueAt.getTime() + DAY - 1),
        createdById: null,
        maintenancePlanId: plan.id,
      },
    });
  return { created: due.length };
}

/** Called when an operations task completes: advances its maintenance plan. */
export async function completeMaintenance(
  tx: Tx,
  task: { maintenancePlanId: string | null; tenantId: string },
  actorId: string,
  now: Date,
) {
  if (!task.maintenancePlanId) return;
  const plan = await tx.maintenancePlan.findFirst({
    where: { id: task.maintenancePlanId, tenantId: task.tenantId },
  });
  if (!plan) return;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  await tx.maintenancePlan.update({
    where: { id: plan.id },
    data: {
      lastDoneAt: now,
      nextDueAt: new Date(today.getTime() + plan.intervalDays * DAY),
    },
  });
  await event(
    tx,
    { id: plan.assetId, tenantId: plan.tenantId },
    'MAINTENANCE',
    actorId,
    {
      note: plan.title,
    },
  );
}

export function startMaintenanceWorker(
  services: Services,
  intervalMs = 60 * 60_000,
) {
  const tick = () =>
    void runMaintenanceScheduler(services).catch(() =>
      services.logger.error('Maintenance scheduler failed'),
    );
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const first = setTimeout(tick, 20_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}

const assetInput = z.object({
  branchId: z.uuid(),
  tag: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  serialNumber: text(80),
  manufacturer: text(80),
  model: text(80),
  location: text(120),
  purchaseDate: isoDate.nullable().optional(),
  purchaseCost: money.nullable().optional(),
  warrantyUntil: isoDate.nullable().optional(),
  notes: text(2000),
  retired: z.boolean().default(false),
});

export function assetsRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const staff = [requireAuth(), staffOnly()];
  const manage = [requireAuth(), requirePermission('assets.manage')];

  router.get('/assets', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, branchId);
    const assets = await db.asset.findMany({
      where: { tenantId: auth.tenantId, branchId: branch.id },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        plans: {
          where: { isActive: true },
          orderBy: { nextDueAt: 'asc' },
          take: 1,
          select: { nextDueAt: true, title: true },
        },
        _count: {
          select: {
            tickets: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
          },
        },
      },
    });
    res.json({
      assets: assets.map(({ plans, _count, ...asset }) => ({
        ...asset,
        nextMaintenance: plans[0] ?? null,
        openTickets: _count.tickets,
      })),
    });
  });

  // QR label lookup: the tag printed on the equipment.
  router.get('/assets/by-tag/:tag', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const tag = parse(z.string().trim().toUpperCase().max(30), req.params.tag);
    const asset = await db.asset.findFirst({
      where: { tenantId: auth.tenantId, tag },
    });
    if (!asset || !canAccessBranch(auth, asset.branchId))
      throw errors.notFound();
    res.json({ id: asset.id });
  });

  router.get('/assets/:id', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    await loadAsset(db, auth, id);
    const asset = await db.asset.findUniqueOrThrow({
      where: { id },
      include: {
        plans: { orderBy: { nextDueAt: 'asc' } },
        tickets: { orderBy: { createdAt: 'desc' }, take: 50 },
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
        branch: { select: { name: true } },
      },
    });
    const costs = asset.tickets
      .filter((ticket) => ticket.status === 'DONE')
      .reduce((sum, ticket) => sum + ticket.laborCost + ticket.partsCost, 0);
    const downtimeMs = asset.tickets.reduce(
      (sum, ticket) =>
        sum +
        ((ticket.downtimeEnd ?? now()).getTime() -
          ticket.downtimeStart.getTime()),
      0,
    );
    res.json({
      asset,
      maintenanceCost: costs,
      downtimeHours: Math.round(downtimeMs / 360_000) / 10,
      warrantyActive:
        asset.warrantyUntil !== null &&
        asset.warrantyUntil.getTime() >= now().getTime() - DAY,
    });
  });

  const assetData = (input: z.infer<typeof assetInput>) => ({
    branchId: input.branchId,
    tag: input.tag,
    name: input.name,
    category: input.category,
    serialNumber: input.serialNumber,
    manufacturer: input.manufacturer,
    model: input.model,
    location: input.location,
    purchaseDate: input.purchaseDate ? day(input.purchaseDate) : null,
    purchaseCost: input.purchaseCost ?? null,
    warrantyUntil: input.warrantyUntil ? day(input.warrantyUntil) : null,
    notes: input.notes,
  });

  async function assertBranch(tx: Tx, auth: AuthContext, branchId: string) {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, tenantId: auth.tenantId, deletedAt: null },
    });
    if (!branch || !canAccessBranch(auth, branch.id))
      throw errors.validation([{ path: 'branchId' }]);
  }

  router.post('/assets', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(assetInput, req.body);
    try {
      const asset = await db.$transaction(async (tx) => {
        await assertBranch(tx, auth, input.branchId);
        const created = await tx.asset.create({
          data: { tenantId: auth.tenantId, ...assetData(input) },
        });
        await event(tx, created, 'CREATED', auth.userId);
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: created.branchId,
          actorUserId: auth.userId,
          action: 'asset.create',
          entityType: 'asset',
          entityId: created.id,
          data: { tag: input.tag },
        });
        return created;
      });
      res.status(201).json({ id: asset.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.put('/assets/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(assetInput, req.body);
    try {
      await db.$transaction(async (tx) => {
        const asset = await loadAsset(tx, auth, id);
        await assertBranch(tx, auth, input.branchId);
        if (asset.status === 'RETIRED') throw errors.conflict();
        await tx.asset.update({
          where: { id },
          data: {
            ...assetData(input),
            ...(input.retired ? { status: 'RETIRED' as const } : {}),
          },
        });
        if (asset.branchId !== input.branchId)
          await event(tx, asset, 'MOVED', auth.userId, {
            note: input.branchId,
          });
        if (input.retired) await event(tx, asset, 'RETIRED', auth.userId);
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: input.branchId,
          actorUserId: auth.userId,
          action: input.retired ? 'asset.retire' : 'asset.update',
          entityType: 'asset',
          entityId: id,
        });
      });
      res.json({ ok: true });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // Equipment safety check; a failed check opens an equipment incident.
  router.post('/assets/:id/safety-checks', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({ passed: z.boolean(), note: text(500) }),
      req.body,
    );
    const incidentId = await db.$transaction(async (tx) => {
      const asset = await loadAsset(tx, auth, id);
      await event(tx, asset, 'SAFETY_CHECK', auth.userId, {
        passed: input.passed,
        note: input.note,
      });
      if (input.passed) return null;
      const incident = await tx.incident.create({
        data: {
          tenantId: auth.tenantId,
          branchId: asset.branchId,
          type: 'EQUIPMENT',
          severity: 'MEDIUM',
          title: `Xavfsizlik tekshiruvi o‘tmadi: ${asset.name} (${asset.tag})`,
          description: input.note ?? 'Izoh kiritilmagan.',
          reportedById: auth.userId,
        },
      });
      await notifyIncident(tx, incident);
      return incident.id;
    });
    res.status(201).json({ incidentId });
  });

  // ------------------------------------------------------- maintenance plans

  router.post('/assets/:id/plans', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        title: z.string().trim().min(2).max(120),
        intervalDays: z.number().int().min(1).max(1825),
        firstDueAt: isoDate,
      }),
      req.body,
    );
    const asset = await loadAsset(db, auth, id);
    const plan = await db.maintenancePlan.create({
      data: {
        tenantId: auth.tenantId,
        assetId: asset.id,
        title: input.title,
        intervalDays: input.intervalDays,
        nextDueAt: day(input.firstDueAt),
      },
    });
    res.status(201).json({ id: plan.id });
  });

  router.patch('/maintenance-plans/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        intervalDays: z.number().int().min(1).max(1825).optional(),
        nextDueAt: isoDate.optional(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    const result = await db.maintenancePlan.updateMany({
      where: { id, tenantId: auth.tenantId },
      data: {
        ...(input.intervalDays ? { intervalDays: input.intervalDays } : {}),
        ...(input.nextDueAt ? { nextDueAt: day(input.nextDueAt) } : {}),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
    if (result.count === 0) throw errors.notFound();
    res.json({ ok: true });
  });

  router.post('/assets/maintenance/run', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    res.json(await runMaintenanceScheduler(services, auth.tenantId));
  });

  // ---------------------------------------------------------- repair tickets

  router.get('/repair-tickets', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        branchId: z.uuid().optional(),
        status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
      }),
      req.query,
    );
    const branch = await resolveBranch(db, auth, query.branchId);
    const tickets = await db.repairTicket.findMany({
      where: {
        tenantId: auth.tenantId,
        asset: { branchId: branch.id },
        ...(query.status
          ? { status: query.status }
          : { status: { in: ['OPEN', 'IN_PROGRESS'] } }),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: { asset: { select: { name: true, tag: true } } },
      take: 200,
    });
    res.json({ tickets });
  });

  router.post('/assets/:id/tickets', ...staff, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        title: z.string().trim().min(3).max(200),
        description: z.string().trim().min(3).max(4000),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
      }),
      req.body,
    );
    const ticket = await db.$transaction(async (tx) => {
      const asset = await loadAsset(tx, auth, id);
      if (asset.status === 'RETIRED') throw errors.conflict();
      const created = await tx.repairTicket.create({
        data: {
          tenantId: auth.tenantId,
          assetId: asset.id,
          title: input.title,
          description: input.description,
          priority: input.priority,
          reportedById: auth.userId,
          downtimeStart: now(),
        },
      });
      await tx.asset.update({
        where: { id: asset.id },
        data: { status: 'IN_REPAIR' },
      });
      await event(tx, asset, 'REPAIR_OPENED', auth.userId, {
        note: input.title,
      });
      return created;
    });
    res.status(201).json({ id: ticket.id });
  });

  /**
   * Progress or close a repair. Closing records costs and downtime; a total at or
   * above the tenant's threshold requires an approved approval request first.
   */
  router.patch('/repair-tickets/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(
      z.object({
        status: z.enum(['IN_PROGRESS', 'DONE', 'CANCELLED']),
        technician: text(120),
        serviceContractId: z.uuid().nullable().optional(),
        parts: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120),
              quantity: z.number().positive().max(10_000),
              cost: money,
            }),
          )
          .max(50)
          .default([]),
        laborCost: money.default(0),
        resolution: text(2000),
      }),
      req.body,
    );
    const result = await db.$transaction(async (tx) => {
      const ticket = await tx.repairTicket.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { asset: true },
      });
      if (!ticket || !canAccessBranch(auth, ticket.asset.branchId))
        throw errors.notFound();
      if (ticket.status === 'DONE' || ticket.status === 'CANCELLED')
        throw errors.conflict();
      if (input.serviceContractId) {
        const contract = await tx.serviceContract.findFirst({
          where: { id: input.serviceContractId, tenantId: auth.tenantId },
        });
        if (!contract) throw errors.validation([{ path: 'serviceContractId' }]);
      }
      const partsCost = input.parts.reduce((sum, part) => sum + part.cost, 0);
      const total = partsCost + input.laborCost;
      const common = {
        technician: input.technician ?? ticket.technician,
        serviceContractId: input.serviceContractId ?? ticket.serviceContractId,
        parts: input.parts,
        partsCost,
        laborCost: input.laborCost,
        resolution: input.resolution ?? ticket.resolution,
      };
      if (input.status === 'DONE') {
        if (!common.resolution)
          throw errors.validation([{ path: 'resolution' }]);
        const profile = await tx.tenantProfile.findUnique({
          where: { tenantId: auth.tenantId },
        });
        const threshold =
          profile?.repairApprovalThreshold ?? DEFAULT_REPAIR_APPROVAL_THRESHOLD;
        if (total >= threshold) {
          const approval = ticket.approvalId
            ? await tx.approvalRequest.findUnique({
                where: { id: ticket.approvalId },
              })
            : null;
          if (
            !approval ||
            approval.status !== 'APPROVED' ||
            (approval.amount ?? 0) < total
          ) {
            const pending =
              approval?.status === 'PENDING' && approval.amount === total
                ? approval
                : await tx.approvalRequest.create({
                    data: {
                      tenantId: auth.tenantId,
                      branchId: ticket.asset.branchId,
                      type: 'REPAIR_COST',
                      entityType: 'repair_ticket',
                      entityId: ticket.id,
                      amount: total,
                      reason: `${ticket.asset.name}: ${ticket.title}`,
                      requestedById: auth.userId,
                    },
                  });
            await tx.repairTicket.update({
              where: { id },
              data: {
                ...common,
                approvalId: pending.id,
                status: 'IN_PROGRESS',
              },
            });
            return { approvalRequired: pending.id };
          }
        }
      }
      const closing = input.status !== 'IN_PROGRESS';
      await tx.repairTicket.update({
        where: { id },
        data: {
          ...common,
          status: input.status,
          ...(closing ? { downtimeEnd: now(), closedById: auth.userId } : {}),
        },
      });
      if (closing) {
        const stillOpen = await tx.repairTicket.count({
          where: {
            assetId: ticket.assetId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
            id: { not: id },
          },
        });
        if (stillOpen === 0 && ticket.asset.status === 'IN_REPAIR')
          await tx.asset.update({
            where: { id: ticket.assetId },
            data: { status: 'ACTIVE' },
          });
        await event(tx, ticket.asset, 'REPAIR_CLOSED', auth.userId, {
          note: common.resolution,
          cost: input.status === 'DONE' ? total : null,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: ticket.asset.branchId,
          actorUserId: auth.userId,
          action: `asset.repair.${input.status.toLowerCase()}`,
          entityType: 'repair_ticket',
          entityId: id,
          data: { total },
        });
      }
      return { approvalRequired: null };
    });
    if (result.approvalRequired)
      throw new AppError(409, 'APPROVAL_REQUIRED', 'approvalRequired', {
        approvalId: result.approvalRequired,
      });
    res.json({ ok: true });
  });

  // -------------------------------------------------------- service contracts

  const contractInput = z.object({
    vendor: z.string().trim().min(2).max(120),
    phone: text(30),
    scope: z.string().trim().min(2).max(2000),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    cost: money.default(0),
    isActive: z.boolean().default(true),
  });
  const contractData = (input: z.infer<typeof contractInput>) => {
    if (input.endDate && input.endDate < input.startDate)
      throw errors.validation([{ path: 'endDate' }]);
    return {
      ...input,
      startDate: day(input.startDate),
      endDate: input.endDate ? day(input.endDate) : null,
    };
  };

  router.get('/service-contracts', ...staff, async (_req, res) => {
    const auth = getAuth(res);
    const contracts = await db.serviceContract.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ isActive: 'desc' }, { vendor: 'asc' }],
    });
    res.json({ contracts });
  });

  router.post('/service-contracts', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(contractInput, req.body);
    const contract = await db.serviceContract.create({
      data: { tenantId: auth.tenantId, ...contractData(input) },
    });
    res.status(201).json({ id: contract.id });
  });

  router.put('/service-contracts/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(contractInput, req.body);
    const result = await db.serviceContract.updateMany({
      where: { id, tenantId: auth.tenantId },
      data: contractData(input),
    });
    if (result.count === 0) throw errors.notFound();
    res.json({ ok: true });
  });

  return router;
}
