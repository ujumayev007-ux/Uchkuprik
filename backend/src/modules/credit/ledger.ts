import type { Tx } from '../../db.js';
import { AppError } from '../../http/errors.js';

/**
 * Customer credit (nasiya) and hotel room accounts: orders are charged to an account
 * and paid back later. Every change is a ledger entry; the account row is locked so
 * the balance and the credit limit hold under concurrent charges.
 */
export async function lockAccount(tx: Tx, tenantId: string, accountId: string) {
  await tx.$queryRaw`SELECT id FROM credit_accounts WHERE id = ${accountId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
  const account = await tx.creditAccount.findFirst({
    where: { id: accountId, tenantId },
  });
  if (!account) throw new AppError(404, 'NOT_FOUND', 'notFound');
  return account;
}

export async function postCredit(
  tx: Tx,
  input: {
    tenantId: string;
    accountId: string;
    type: 'CHARGE' | 'REPAYMENT' | 'REFUND' | 'ADJUSTMENT';
    // Positive raises the debt, negative lowers it.
    amount: number;
    orderId?: string | null;
    paymentId?: string | null;
    method?: string | null;
    shiftId?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
    actorId: string | null;
  },
) {
  const account = await lockAccount(tx, input.tenantId, input.accountId);
  if (input.type === 'CHARGE') {
    if (!account.isOpen)
      throw new AppError(409, 'CREDIT_ACCOUNT_CLOSED', 'creditAccountClosed');
    if (
      account.creditLimit !== null &&
      account.balance + input.amount > account.creditLimit
    )
      throw new AppError(409, 'CREDIT_LIMIT', 'creditLimit', {
        available: Math.max(0, account.creditLimit - account.balance),
      });
  }
  const balanceAfter = account.balance + input.amount;
  await tx.creditAccount.update({
    where: { id: account.id },
    data: { balance: balanceAfter },
  });
  const entry = await tx.creditEntry.create({
    data: {
      tenantId: input.tenantId,
      accountId: account.id,
      type: input.type,
      amount: input.amount,
      balanceAfter,
      orderId: input.orderId ?? null,
      paymentId: input.paymentId ?? null,
      method: input.method ?? null,
      shiftId: input.shiftId ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdById: input.actorId,
    },
  });
  return { account: { ...account, balance: balanceAfter }, entry };
}

/** The account a CREDIT payment was charged to. */
export async function accountOfPayment(tx: Tx, paymentId: string) {
  const charge = await tx.creditEntry.findFirst({
    where: { paymentId, type: 'CHARGE' },
    select: { accountId: true },
  });
  return charge?.accountId ?? null;
}

export const accountLabel = (account: {
  kind: string;
  name: string;
  room: string | null;
}) =>
  account.kind === 'HOTEL_ROOM' && account.room
    ? `Xona ${account.room} — ${account.name}`
    : account.name;
