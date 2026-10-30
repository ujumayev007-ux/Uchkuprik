import { Router } from 'express';
import { z } from 'zod';
import type { Services } from '../../context.js';
import { AppError, errors, parse } from '../../http/errors.js';
import { audit } from '../audit/audit.js';
import {
  getAuth,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../auth/session.js';
import { resolveBranch } from '../branches/access.js';
import { findOpenShift } from '../shifts/shifts.routes.js';
import { accountLabel, lockAccount, postCredit } from './ledger.js';

const accountInput = z.object({
  kind: z.enum(['CUSTOMER', 'HOTEL_ROOM']),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullable().optional(),
  room: z.string().trim().max(20).nullable().optional(),
  customerId: z.uuid().nullable().optional(),
  creditLimit: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  checkoutAt: z.iso.datetime().nullable().optional(),
});
const repaymentMethods = [
  'CASH',
  'CARD',
  'CLICK',
  'PAYME',
  'UZUM',
  'QR',
  'OTHER',
] as const;

/**
 * Qarz hisoblari: customer credit (nasiya, workflow 17) and hotel room bills
 * (workflow 18). Orders are charged with the CREDIT payment method; repayments in cash
 * go into the open cash shift as a pay-in, so the drawer still reconciles.
 */
export function creditRouter(services: Services) {
  const { db } = services;
  const router = Router();
  const view = [
    requireAuth(),
    requireAnyPermission('customers.view', 'payments.accept'),
  ];
  const manage = [requireAuth(), requirePermission('customers.manage')];

  router.get('/credit-accounts', ...view, async (req, res) => {
    const auth = getAuth(res);
    const query = parse(
      z.object({
        open: z.enum(['true', 'false']).optional(),
        kind: z.enum(['CUSTOMER', 'HOTEL_ROOM']).optional(),
        q: z.string().trim().max(60).optional(),
      }),
      req.query,
    );
    const accounts = await db.creditAccount.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(query.open ? { isOpen: query.open === 'true' } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { phone: { contains: query.q } },
                { room: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ isOpen: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
    });
    res.json({
      accounts: accounts.map((account) => ({
        ...account,
        label: accountLabel(account),
        available:
          account.creditLimit === null
            ? null
            : Math.max(0, account.creditLimit - account.balance),
      })),
      totalDebt: accounts.reduce((sum, a) => sum + Math.max(0, a.balance), 0),
    });
  });

  router.get('/credit-accounts/:id', ...view, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const account = await db.creditAccount.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { entries: { orderBy: { createdAt: 'desc' }, take: 300 } },
    });
    if (!account) throw errors.notFound();
    const orderIds = account.entries
      .map((entry) => entry.orderId)
      .filter((value): value is string => !!value);
    const orders = await db.order.findMany({
      where: { tenantId: auth.tenantId, id: { in: orderIds } },
      select: { id: true, number: true, businessDate: true, total: true },
    });
    res.json({
      account: { ...account, label: accountLabel(account) },
      orders,
    });
  });

  router.post('/credit-accounts', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const input = parse(accountInput, req.body);
    if (input.kind === 'HOTEL_ROOM' && !input.room)
      throw errors.validation([{ path: 'room' }]);
    if (input.customerId) {
      const customer = await db.customer.findFirst({
        where: { id: input.customerId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!customer) throw errors.validation([{ path: 'customerId' }]);
    }
    const account = await db.$transaction(async (tx) => {
      const created = await tx.creditAccount.create({
        data: {
          tenantId: auth.tenantId,
          kind: input.kind,
          name: input.name,
          phone: input.phone ?? null,
          room: input.room ?? null,
          customerId: input.customerId ?? null,
          creditLimit: input.creditLimit ?? null,
          note: input.note ?? null,
          checkoutAt: input.checkoutAt ? new Date(input.checkoutAt) : null,
          createdById: auth.userId,
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'credit.account.create',
        entityType: 'credit_account',
        entityId: created.id,
        data: {
          kind: input.kind,
          name: input.name,
          room: input.room ?? null,
          creditLimit: input.creditLimit ?? null,
        },
      });
      return created;
    });
    res.status(201).json({ account });
  });

  router.patch('/credit-accounts/:id', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const input = parse(accountInput.omit({ kind: true }).partial(), req.body);
    const account = await db.$transaction(async (tx) => {
      const before = await lockAccount(tx, auth.tenantId, id);
      const updated = await tx.creditAccount.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.room !== undefined ? { room: input.room } : {}),
          ...(input.creditLimit !== undefined
            ? { creditLimit: input.creditLimit }
            : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.checkoutAt !== undefined
            ? {
                checkoutAt: input.checkoutAt
                  ? new Date(input.checkoutAt)
                  : null,
              }
            : {}),
        },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'credit.account.update',
        entityType: 'credit_account',
        entityId: id,
        data: {
          before: { name: before.name, creditLimit: before.creditLimit },
          changes: input,
        },
      });
      return updated;
    });
    res.json({ account });
  });

  // A repayment (or the hotel guest settling the room bill at checkout).
  router.post(
    '/credit-accounts/:id/repayments',
    requireAuth(),
    requirePermission('payments.accept'),
    async (req, res) => {
      const auth = getAuth(res);
      const id = parse(z.uuid(), req.params.id);
      const input = parse(
        z.object({
          idempotencyKey: z.string().trim().min(8).max(80),
          method: z.enum(repaymentMethods),
          amount: z.number().int().min(1).max(1_000_000_000),
          note: z.string().trim().max(200).nullable().optional(),
          branchId: z.uuid().optional(),
        }),
        req.body,
      );
      const existing = await db.creditEntry.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: auth.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.accountId !== id) throw errors.conflict();
        res.json({ entry: existing });
        return;
      }
      const branch = await resolveBranch(db, auth, input.branchId);
      const result = await db.$transaction(async (tx) => {
        const account = await lockAccount(tx, auth.tenantId, id);
        if (input.amount > account.balance)
          throw new AppError(409, 'AMOUNT_EXCEEDS_DUE', 'amountExceedsDue', {
            due: account.balance,
          });
        // Cash goes into this register's drawer: an open shift is required.
        const shift = await findOpenShift(tx, auth, branch.id);
        if (input.method === 'CASH' && !shift)
          throw new AppError(409, 'SHIFT_REQUIRED', 'shiftRequired');
        if (input.method === 'CASH')
          await tx.cashMovement.create({
            data: {
              tenantId: auth.tenantId,
              shiftId: shift!.id,
              amount: input.amount,
              reason: `Qarz to‘lovi: ${accountLabel(account)}`.slice(0, 200),
              createdById: auth.userId,
            },
          });
        const posted = await postCredit(tx, {
          tenantId: auth.tenantId,
          accountId: id,
          type: 'REPAYMENT',
          amount: -input.amount,
          method: input.method,
          shiftId: shift?.id ?? null,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey,
          actorId: auth.userId,
        });
        await audit(tx, req, {
          tenantId: auth.tenantId,
          branchId: branch.id,
          actorUserId: auth.userId,
          action: 'credit.repayment',
          entityType: 'credit_account',
          entityId: id,
          data: {
            amount: input.amount,
            method: input.method,
            balanceAfter: posted.account.balance,
          },
        });
        return posted;
      });
      res.status(201).json({ entry: result.entry, account: result.account });
    },
  );

  // Hotel checkout / closing a customer's credit: only a settled account.
  router.post('/credit-accounts/:id/close', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const account = await db.$transaction(async (tx) => {
      const current = await lockAccount(tx, auth.tenantId, id);
      if (current.balance > 0)
        throw new AppError(409, 'CREDIT_NOT_SETTLED', 'creditNotSettled', {
          balance: current.balance,
        });
      const closed = await tx.creditAccount.update({
        where: { id },
        data: { isOpen: false, closedAt: new Date(), closedById: auth.userId },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'credit.account.close',
        entityType: 'credit_account',
        entityId: id,
      });
      return closed;
    });
    res.json({ account });
  });

  router.post('/credit-accounts/:id/reopen', ...manage, async (req, res) => {
    const auth = getAuth(res);
    const id = parse(z.uuid(), req.params.id);
    const account = await db.$transaction(async (tx) => {
      await lockAccount(tx, auth.tenantId, id);
      const reopened = await tx.creditAccount.update({
        where: { id },
        data: { isOpen: true, closedAt: null, closedById: null },
      });
      await audit(tx, req, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'credit.account.reopen',
        entityType: 'credit_account',
        entityId: id,
      });
      return reopened;
    });
    res.json({ account });
  });

  return router;
}
