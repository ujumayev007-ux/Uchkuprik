import { Router } from 'express';
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
  requireRecentAuth,
  type AuthContext,
} from '../auth/session.js';
import { assertBrand } from '../brands/brands.routes.js';
import { csv } from '../finance/finance.routes.js';

const DAY = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => value || null);

// Optional form fields: an empty string means "not provided".
const blankable = <T extends z.ZodType>(schema: T) =>
  z
    .preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === '' ? null : value,
      schema.nullable().optional(),
    )
    .transform((value) => value ?? null);

const franchiseeInput = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: text(200),
  taxId: blankable(
    z
      .string()
      .trim()
      .regex(/^\d{9}$|^\d{14}$/),
  ),
  contactName: text(80),
  phone: blankable(
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/),
  ),
  email: blankable(z.email().max(120)),
  status: z
    .enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'])
    .default('ONBOARDING'),
  notes: text(1000),
  // Branches operated by this franchisee; others previously assigned are released.
  branchIds: z.array(z.uuid()).max(500).default([]),
});

const contractInput = z.object({
  franchiseeId: z.uuid(),
  brandId: z.uuid().nullable().optional(),
  number: z.string().trim().min(1).max(40),
  territory: z.string().trim().min(2).max(200),
  exclusive: z.boolean().default(false),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  royaltyBp: z.number().int().min(0).max(5000),
  marketingFeeBp: z.number().int().min(0).max(5000).default(0),
  minimumMonthlyFee: z.number().int().min(0).max(1_000_000_000).default(0),
});

const inspectionInput = z.object({
  branchId: z.uuid(),
  inspectedAt: z.coerce.date(),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        passed: z.boolean(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(100),
  notes: text(2000),
});

const agreementInput = z.object({
  supplierId: z.uuid(),
  brandId: z.uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  terms: text(4000),
  isActive: z.boolean().default(true),
});

export function monthRange(month: string) {
  const start = day(`${month}-01`);
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  );
  return { start, end };
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const normalizeTerritory = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

type Contract = {
  id: string;
  tenantId: string;
  franchiseeId: string;
  brandId: string | null;
  startDate: Date;
  endDate: Date | null;
  royaltyBp: number;
  marketingFeeBp: number;
  minimumMonthlyFee: number;
  terminatedAt: Date | null;
};

/**
 * Royalty for one contract and month: completed sales of the franchisee's branches
 * (restricted to the licensed brand) within the contract dates, minus refunds of those
 * orders. Fees are basis points of net sales; the minimum fee tops up the royalty.
 */
export async function computeStatement(
  tx: Tx,
  contract: Contract,
  month: string,
) {
  const range = monthRange(month);
  const from = new Date(
    Math.max(range.start.getTime(), contract.startDate.getTime()),
  );
  const endCandidates = [range.end.getTime()];
  if (contract.endDate) endCandidates.push(contract.endDate.getTime());
  if (contract.terminatedAt)
    endCandidates.push(day(iso(contract.terminatedAt)).getTime());
  const to = new Date(Math.min(...endCandidates));
  const branches = await tx.branch.findMany({
    where: {
      tenantId: contract.tenantId,
      franchiseeId: contract.franchiseeId,
      ...(contract.brandId ? { brandId: contract.brandId } : {}),
    },
    select: { id: true },
  });
  const branchIds = branches.map((branch) => branch.id);
  let grossSales = 0;
  let refunds = 0;
  if (to >= from && branchIds.length > 0) {
    const where = {
      tenantId: contract.tenantId,
      branchId: { in: branchIds },
      status: 'COMPLETED' as const,
      businessDate: { gte: from, lte: to },
    };
    const [sales, refunded] = await Promise.all([
      tx.order.aggregate({ where, _sum: { total: true } }),
      tx.refund.aggregate({
        where: { tenantId: contract.tenantId, order: where },
        _sum: { amount: true },
      }),
    ]);
    grossSales = sales._sum.total ?? 0;
    refunds = refunded._sum.amount ?? 0;
  }
  const netSales = Math.max(0, grossSales - refunds);
  const royalty = Math.round((netSales * contract.royaltyBp) / 10_000);
  const marketingFee = Math.round(
    (netSales * contract.marketingFeeBp) / 10_000,
  );
  const minimumTopUp =
    to >= from ? Math.max(0, contract.minimumMonthlyFee - royalty) : 0;
  return {
    grossSales,
    refunds,
    netSales,
    royalty,
    marketingFee,
    minimumTopUp,
    total: royalty + marketingFee + minimumTopUp,
  };
}

/** Franchisee ids visible to a portal user: those operating branches the user can access. */
async function portalFranchiseeIds(tx: Tx, auth: AuthContext) {
  const branches = await tx.branch.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      franchiseeId: { not: null },
      ...(auth.allBranches ? {} : { id: { in: auth.branchIds } }),
    },
    select: { franchiseeId: true },
  });
  return [...new Set(branches.map((branch) => branch.franchiseeId!))];
}

export function franchiseRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const now = () => services.now?.() ?? new Date();
  const manage = [requireAuth(), requirePermission('franchise.manage')];
  const stepUp = requireRecentAuth(services);

  // ------------------------------------------------------------- franchisees

  router.get('/franchise/franchisees', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const rows = await db.franchisee.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { name: 'asc' },
      include: {
        branches: {
          where: { deletedAt: null },
          select: { id: true, name: true, brandId: true },
        },
        _count: { select: { contracts: true } },
      },
    });
    res.json({
      franchisees: rows.map(({ _count, ...row }) => ({
        ...row,
        contractCount: _count.contracts,
      })),
    });
  });

  async function saveFranchisee(
    tx: Tx,
    auth: AuthContext,
    id: string | null,
    input: z.infer<typeof franchiseeInput>,
  ) {
    const { branchIds, ...data } = input;
    const branches = await tx.branch.findMany({
      where: {
        tenantId: auth.tenantId,
        id: { in: branchIds },
        deletedAt: null,
      },
      select: { id: true, franchiseeId: true },
    });
    if (branches.length !== new Set(branchIds).size)
      throw errors.validation([{ path: 'branchIds' }]);
    // A branch belongs to at most one franchisee at a time.
    if (branches.some((b) => b.franchiseeId && b.franchiseeId !== id))
      throw new AppError(409, 'BRANCH_FRANCHISED', 'branchFranchised');
    const saved = id
      ? await tx.franchisee.update({ where: { id }, data })
      : await tx.franchisee.create({
          data: { tenantId: auth.tenantId, ...data },
        });
    await tx.branch.updateMany({
      where: {
        tenantId: auth.tenantId,
        franchiseeId: saved.id,
        id: { notIn: branchIds },
      },
      data: { franchiseeId: null },
    });
    if (branchIds.length > 0)
      await tx.branch.updateMany({
        where: { tenantId: auth.tenantId, id: { in: branchIds } },
        data: { franchiseeId: saved.id },
      });
    return saved;
  }

  router.post('/franchise/franchisees', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(franchiseeInput, req.body);
    try {
      const saved = await db.$transaction(async (tx) => {
        const created = await saveFranchisee(tx, auth, null, input);
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.franchisee.create',
          entityType: 'franchisee',
          entityId: created.id,
          data: { name: input.name, branchIds: input.branchIds },
        });
        return created;
      });
      res.status(201).json({ id: saved.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.put('/franchise/franchisees/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(franchiseeInput, req.body);
    try {
      await db.$transaction(async (tx) => {
        const found = await tx.franchisee.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!found) throw errors.notFound();
        await saveFranchisee(tx, auth, id, input);
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.franchisee.update',
          entityType: 'franchisee',
          entityId: id,
          data: { status: input.status, branchIds: input.branchIds },
        });
      });
      res.json({ ok: true });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // --------------------------------------------------------------- contracts

  router.get('/franchise/contracts', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const contracts = await db.franchiseContract.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: {
        franchisee: { select: { name: true } },
        brand: { select: { name: true } },
      },
    });
    res.json({ contracts });
  });

  async function assertContractRefs(
    tx: Tx,
    tenantId: string,
    input: z.infer<typeof contractInput>,
  ) {
    const franchisee = await tx.franchisee.findFirst({
      where: { id: input.franchiseeId, tenantId },
    });
    if (!franchisee) throw errors.validation([{ path: 'franchiseeId' }]);
    await assertBrand(tx, tenantId, input.brandId);
    if (input.endDate && input.endDate < input.startDate)
      throw errors.validation([{ path: 'endDate' }]);
  }

  const contractData = (input: z.infer<typeof contractInput>) => ({
    franchiseeId: input.franchiseeId,
    brandId: input.brandId ?? null,
    number: input.number,
    territory: input.territory,
    exclusive: input.exclusive,
    startDate: day(input.startDate),
    endDate: input.endDate ? day(input.endDate) : null,
    royaltyBp: input.royaltyBp,
    marketingFeeBp: input.marketingFeeBp,
    minimumMonthlyFee: input.minimumMonthlyFee,
  });

  router.post('/franchise/contracts', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(contractInput, req.body);
    try {
      const contract = await db.$transaction(async (tx) => {
        await assertContractRefs(tx, auth.tenantId, input);
        const created = await tx.franchiseContract.create({
          data: { tenantId: auth.tenantId, ...contractData(input) },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.contract.create',
          entityType: 'franchise_contract',
          entityId: created.id,
          data: { number: input.number, royaltyBp: input.royaltyBp },
        });
        return created;
      });
      res.status(201).json({ id: contract.id });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  // Terms are editable only while the contract is a draft.
  router.put('/franchise/contracts/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(contractInput, req.body);
    try {
      await db.$transaction(async (tx) => {
        const found = await tx.franchiseContract.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!found) throw errors.notFound();
        if (found.status !== 'DRAFT')
          throw new AppError(409, 'CONTRACT_LOCKED', 'contractLocked');
        await assertContractRefs(tx, auth.tenantId, input);
        await tx.franchiseContract.update({
          where: { id },
          data: contractData(input),
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.contract.update',
          entityType: 'franchise_contract',
          entityId: id,
          data: { royaltyBp: input.royaltyBp, territory: input.territory },
        });
      });
      res.json({ ok: true });
    } catch (error) {
      if (isUniqueViolation(error)) throw errors.conflict();
      throw error;
    }
  });

  router.post(
    '/franchise/contracts/:id/activate',
    ...manage,
    stepUp,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        // Serialize activations per tenant so exclusivity checks cannot race.
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${auth.tenantId}::uuid FOR UPDATE`;
        const contract = await tx.franchiseContract.findFirst({
          where: { id, tenantId: auth.tenantId },
        });
        if (!contract) throw errors.notFound();
        if (contract.status !== 'DRAFT')
          throw new AppError(409, 'CONTRACT_LOCKED', 'contractLocked');
        const active = await tx.franchiseContract.findMany({
          where: {
            tenantId: auth.tenantId,
            status: 'ACTIVE',
            brandId: contract.brandId,
            id: { not: id },
          },
        });
        const overlaps = active.filter(
          (other) =>
            normalizeTerritory(other.territory) ===
              normalizeTerritory(contract.territory) &&
            (other.exclusive || contract.exclusive) &&
            other.startDate <= (contract.endDate ?? new Date(8.64e15)) &&
            contract.startDate <= (other.endDate ?? new Date(8.64e15)),
        );
        if (overlaps.length > 0)
          throw new AppError(409, 'TERRITORY_CONFLICT', 'territoryConflict', {
            contractIds: overlaps.map((other) => other.id),
          });
        await tx.franchiseContract.update({
          where: { id },
          data: { status: 'ACTIVE', activatedAt: now() },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.contract.activate',
          entityType: 'franchise_contract',
          entityId: id,
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/franchise/contracts/:id/terminate',
    ...manage,
    stepUp,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { reason } = parse(
        z.object({ reason: z.string().trim().min(3).max(500) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const result = await tx.franchiseContract.updateMany({
          where: { id, tenantId: auth.tenantId, status: 'ACTIVE' },
          data: {
            status: 'TERMINATED',
            terminatedAt: now(),
            terminationReason: reason,
          },
        });
        if (result.count === 0) throw errors.conflict();
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.contract.terminate',
          entityType: 'franchise_contract',
          entityId: id,
          data: { reason },
        });
      });
      res.json({ ok: true });
    },
  );

  // -------------------------------------------------------------- statements

  const statementInclude = {
    contract: {
      select: {
        number: true,
        territory: true,
        royaltyBp: true,
        marketingFeeBp: true,
        franchisee: { select: { id: true, name: true } },
        brand: { select: { name: true } },
      },
    },
  } as const;

  router.get('/franchise/statements', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { month } = parse(
      z.object({ month: monthSchema.optional() }),
      req.query,
    );
    const statements = await db.royaltyStatement.findMany({
      where: { tenantId: auth.tenantId, ...(month ? { month } : {}) },
      orderBy: [{ month: 'desc' }, { createdAt: 'asc' }],
      include: statementInclude,
      take: 500,
    });
    res.json({ statements });
  });

  router.post('/franchise/statements/generate', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { month } = parse(z.object({ month: monthSchema }), req.body);
    const range = monthRange(month);
    if (range.start > now()) throw errors.validation([{ path: 'month' }]);
    const result = await db.$transaction(async (tx) => {
      const contracts = await tx.franchiseContract.findMany({
        where: {
          tenantId: auth.tenantId,
          status: { in: ['ACTIVE', 'TERMINATED'] },
          startDate: { lte: range.end },
          OR: [{ endDate: null }, { endDate: { gte: range.start } }],
        },
      });
      let created = 0;
      let updated = 0;
      let locked = 0;
      for (const contract of contracts) {
        if (contract.terminatedAt && contract.terminatedAt < range.start)
          continue;
        const existing = await tx.royaltyStatement.findUnique({
          where: { contractId_month: { contractId: contract.id, month } },
        });
        if (existing && existing.status !== 'DRAFT') {
          locked += 1;
          continue;
        }
        const amounts = await computeStatement(tx, contract, month);
        if (existing) {
          await tx.royaltyStatement.update({
            where: { id: existing.id },
            data: amounts,
          });
          updated += 1;
        } else {
          await tx.royaltyStatement.create({
            data: {
              tenantId: auth.tenantId,
              contractId: contract.id,
              month,
              ...amounts,
            },
          });
          created += 1;
        }
      }
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'franchise.statements.generate',
        entityType: 'royalty_statement',
        data: { month, created, updated, locked },
      });
      return { created, updated, locked };
    });
    res.json(result);
  });

  router.post(
    '/franchise/statements/:id/issue',
    ...manage,
    stepUp,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      await db.$transaction(async (tx) => {
        const statement = await tx.royaltyStatement.findFirst({
          where: { id, tenantId: auth.tenantId },
          include: { contract: true },
        });
        if (!statement || statement.status !== 'DRAFT') throw errors.conflict();
        // Issue only for finished months, recomputed so the figures are final.
        if (monthRange(statement.month).end >= day(iso(now())))
          throw new AppError(409, 'MONTH_NOT_FINISHED', 'monthNotFinished');
        const amounts = await computeStatement(
          tx,
          statement.contract,
          statement.month,
        );
        await tx.royaltyStatement.update({
          where: { id },
          data: { ...amounts, status: 'ISSUED', issuedAt: now() },
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.statement.issue',
          entityType: 'royalty_statement',
          entityId: id,
          data: { month: statement.month, total: amounts.total },
        });
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/franchise/statements/:id/paid',
    ...manage,
    stepUp,
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const { reference } = parse(
        z.object({ reference: z.string().trim().min(2).max(100) }),
        req.body,
      );
      await db.$transaction(async (tx) => {
        const result = await tx.royaltyStatement.updateMany({
          where: { id, tenantId: auth.tenantId, status: 'ISSUED' },
          data: { status: 'PAID', paidAt: now(), reference },
        });
        if (result.count === 0) throw errors.conflict();
        await audit(tx, req, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'franchise.statement.paid',
          entityType: 'royalty_statement',
          entityId: id,
          data: { reference },
        });
      });
      res.json({ ok: true });
    },
  );

  router.get('/franchise/statements.csv', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { month } = parse(z.object({ month: monthSchema }), req.query);
    const statements = await db.royaltyStatement.findMany({
      where: { tenantId: auth.tenantId, month },
      include: statementInclude,
      orderBy: { createdAt: 'asc' },
    });
    csv(
      res,
      `royalti-${month}.csv`,
      [
        'Franchayzi',
        'Shartnoma',
        'Hudud',
        'Yalpi savdo',
        'Qaytarishlar',
        'Sof savdo',
        'Royalti',
        'Marketing',
        'Minimal to‘lov farqi',
        'Jami',
        'Holati',
      ],
      statements.map((row) => [
        row.contract.franchisee.name,
        row.contract.number,
        row.contract.territory,
        row.grossSales,
        row.refunds,
        row.netSales,
        row.royalty,
        row.marketingFee,
        row.minimumTopUp,
        row.total,
        row.status,
      ]),
    );
  });

  // ------------------------------------------------------------- inspections

  router.get('/franchise/inspections', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { branchId } = parse(
      z.object({ branchId: z.uuid().optional() }),
      req.query,
    );
    const inspections = await db.inspection.findMany({
      where: { tenantId: auth.tenantId, ...(branchId ? { branchId } : {}) },
      orderBy: { inspectedAt: 'desc' },
      take: 200,
      include: { branch: { select: { name: true } } },
    });
    res.json({ inspections });
  });

  router.post('/franchise/inspections', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(inspectionInput, req.body);
    if (input.inspectedAt.getTime() > now().getTime() + 5 * 60_000)
      throw errors.validation([{ path: 'inspectedAt' }]);
    const branch = await db.branch.findFirst({
      where: { id: input.branchId, tenantId: auth.tenantId, deletedAt: null },
    });
    if (!branch || !canAccessBranch(auth, branch.id)) throw errors.forbidden();
    const passed = input.items.filter((item) => item.passed).length;
    const score = Math.round((passed / input.items.length) * 100);
    const inspection = await db.$transaction(async (tx) => {
      const created = await tx.inspection.create({
        data: {
          tenantId: auth.tenantId,
          branchId: branch.id,
          inspectorId: auth.userId,
          inspectedAt: input.inspectedAt,
          items: input.items,
          score,
          notes: input.notes,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        branchId: branch.id,
        actorUserId: auth.userId,
        action: 'franchise.inspection.create',
        entityType: 'inspection',
        entityId: created.id,
        data: { score },
      });
      return created;
    });
    res.status(201).json({ id: inspection.id, score });
  });

  // -------------------------------------------------------------- scorecards

  router.get('/franchise/scorecards', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const { month } = parse(z.object({ month: monthSchema }), req.query);
    const range = monthRange(month);
    const since = new Date(now().getTime() - 90 * DAY);
    const franchisees = await db.franchisee.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { name: 'asc' },
      include: {
        branches: { where: { deletedAt: null }, select: { id: true } },
        contracts: {
          where: { status: 'ACTIVE' },
          select: { number: true, endDate: true },
        },
      },
    });
    const cards = [];
    for (const franchisee of franchisees) {
      const branchIds = franchisee.branches.map((branch) => branch.id);
      const [sales, inspections, outstanding] = await Promise.all([
        db.order.aggregate({
          where: {
            tenantId: auth.tenantId,
            branchId: { in: branchIds },
            status: 'COMPLETED',
            businessDate: { gte: range.start, lte: range.end },
          },
          _sum: { total: true },
          _count: true,
        }),
        db.inspection.aggregate({
          where: {
            tenantId: auth.tenantId,
            branchId: { in: branchIds },
            inspectedAt: { gte: since },
          },
          _avg: { score: true },
          _count: true,
          _max: { inspectedAt: true },
        }),
        db.royaltyStatement.aggregate({
          where: {
            tenantId: auth.tenantId,
            status: 'ISSUED',
            contract: { franchiseeId: franchisee.id },
          },
          _sum: { total: true },
        }),
      ]);
      const contractEnds = franchisee.contracts
        .map((contract) => contract.endDate)
        .filter((date): date is Date => date !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      cards.push({
        franchiseeId: franchisee.id,
        name: franchisee.name,
        status: franchisee.status,
        branchCount: branchIds.length,
        activeContracts: franchisee.contracts.length,
        contractEndsAt: contractEnds ?? null,
        sales: sales._sum.total ?? 0,
        orders: sales._count,
        averageScore:
          inspections._avg.score === null
            ? null
            : Math.round(inspections._avg.score),
        inspections: inspections._count,
        lastInspectionAt: inspections._max.inspectedAt,
        outstanding: outstanding._sum.total ?? 0,
      });
    }
    res.json({ month, scorecards: cards });
  });

  // ---------------------------------------------------------------- portal

  router.get(
    '/franchise/portal',
    requireAuth(),
    requirePermission('franchise.portal'),
    async (_req, res) => {
      const auth = getAuth(res);
      const data = await db.$transaction(async (tx) => {
        const ids = await portalFranchiseeIds(tx, auth);
        const franchisees = await tx.franchisee.findMany({
          where: { tenantId: auth.tenantId, id: { in: ids } },
          select: {
            id: true,
            name: true,
            legalName: true,
            status: true,
            branches: {
              where: {
                deletedAt: null,
                ...(auth.allBranches ? {} : { id: { in: auth.branchIds } }),
              },
              select: { id: true, name: true },
            },
            contracts: {
              where: { status: { in: ['ACTIVE', 'TERMINATED'] } },
              select: {
                id: true,
                number: true,
                territory: true,
                exclusive: true,
                startDate: true,
                endDate: true,
                royaltyBp: true,
                marketingFeeBp: true,
                minimumMonthlyFee: true,
                status: true,
                brand: { select: { name: true } },
              },
            },
          },
        });
        const branchIds = franchisees.flatMap((f) =>
          f.branches.map((b) => b.id),
        );
        const [statements, inspections] = await Promise.all([
          tx.royaltyStatement.findMany({
            where: {
              tenantId: auth.tenantId,
              status: { in: ['ISSUED', 'PAID'] },
              contract: { franchiseeId: { in: ids } },
            },
            orderBy: { month: 'desc' },
            take: 36,
            include: { contract: { select: { number: true } } },
          }),
          tx.inspection.findMany({
            where: { tenantId: auth.tenantId, branchId: { in: branchIds } },
            orderBy: { inspectedAt: 'desc' },
            take: 50,
            include: { branch: { select: { name: true } } },
          }),
        ]);
        return { franchisees, statements, inspections };
      });
      res.json(data);
    },
  );

  // ------------------------------------------------------ supplier agreements

  router.get('/supplier-agreements', ...manage, async (_req, res) => {
    const auth = getAuth(res);
    const agreements = await db.supplierAgreement.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      include: {
        supplier: { select: { name: true } },
        brand: { select: { name: true } },
      },
    });
    res.json({ agreements });
  });

  async function saveAgreement(
    tx: Tx,
    auth: AuthContext,
    id: string | null,
    input: z.infer<typeof agreementInput>,
  ) {
    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, tenantId: auth.tenantId },
    });
    if (!supplier) throw errors.validation([{ path: 'supplierId' }]);
    await assertBrand(tx, auth.tenantId, input.brandId);
    if (input.endDate && input.endDate < input.startDate)
      throw errors.validation([{ path: 'endDate' }]);
    const data = {
      supplierId: input.supplierId,
      brandId: input.brandId ?? null,
      title: input.title,
      startDate: day(input.startDate),
      endDate: input.endDate ? day(input.endDate) : null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      terms: input.terms,
      isActive: input.isActive,
    };
    return id
      ? tx.supplierAgreement.update({ where: { id }, data })
      : tx.supplierAgreement.create({
          data: { tenantId: auth.tenantId, ...data },
        });
  }

  router.post('/supplier-agreements', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(agreementInput, req.body);
    const saved = await db.$transaction(async (tx) => {
      const created = await saveAgreement(tx, auth, null, input);
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'supplier.agreement.create',
        entityType: 'supplier_agreement',
        entityId: created.id,
        data: { title: input.title },
      });
      return created;
    });
    res.status(201).json({ id: saved.id });
  });

  router.put('/supplier-agreements/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(agreementInput, req.body);
    await db.$transaction(async (tx) => {
      const found = await tx.supplierAgreement.findFirst({
        where: { id, tenantId: auth.tenantId },
      });
      if (!found) throw errors.notFound();
      await saveAgreement(tx, auth, id, input);
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'supplier.agreement.update',
        entityType: 'supplier_agreement',
        entityId: id,
        data: { isActive: input.isActive },
      });
    });
    res.json({ ok: true });
  });

  return router;
}
