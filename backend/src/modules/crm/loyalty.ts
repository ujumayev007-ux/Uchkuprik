import { loyaltyRulesOf, ruleTier } from './loyalty-rules.js';
import type { Tx } from '../../db.js';
import type { LoyaltyEntryType } from '../../generated/prisma/client.js';
import { AppError } from '../../http/errors.js';

/** Uzbek numbers normalized to +998XXXXXXXXX; other numbers keep their digits. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export async function upsertCustomer(
  tx: Tx,
  tenantId: string,
  phone: string,
  name?: string | null,
) {
  const normalized = normalizePhone(phone);
  if (!normalized)
    throw new AppError(400, 'VALIDATION_ERROR', 'validation', [
      { path: 'phone' },
    ]);
  return tx.customer.upsert({
    where: { tenantId_phone: { tenantId, phone: normalized } },
    create: { tenantId, phone: normalized, name: name?.trim() || null },
    update: name?.trim() ? { name: name.trim() } : {},
  });
}

/** VIP tier from lifetime spend (so‘m). */
export function tierOf(totalSpent: number) {
  if (totalSpent >= 20_000_000) return 'PLATINUM';
  if (totalSpent >= 5_000_000) return 'GOLD';
  if (totalSpent >= 1_000_000) return 'SILVER';
  return 'STANDARD';
}

/**
 * Posts a loyalty ledger entry under a row lock on the customer, keeping
 * customers.points equal to the ledger balance and never below zero.
 */
export async function postLoyalty(
  tx: Tx,
  input: {
    tenantId: string;
    customerId: string;
    type: LoyaltyEntryType;
    points: number;
    orderId?: string | null;
    paymentId?: string | null;
    reason?: string | null;
    actorId: string | null;
  },
) {
  if (input.points === 0) return null;
  const rows = await tx.$queryRaw<{ points: number }[]>`
    SELECT points FROM customers WHERE id = ${input.customerId}::uuid AND "tenantId" = ${input.tenantId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'notFound');
  const balance = rows[0].points + input.points;
  if (balance < 0)
    throw new AppError(409, 'INSUFFICIENT_POINTS', 'insufficientPoints', {
      available: rows[0].points,
    });
  await tx.customer.update({
    where: { id: input.customerId },
    data: { points: balance },
  });
  return tx.loyaltyEntry.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: input.type,
      points: input.points,
      balanceAfter: balance,
      orderId: input.orderId ?? null,
      paymentId: input.paymentId ?? null,
      reason: input.reason ?? null,
      createdById: input.actorId,
    },
  });
}

/**
 * On order completion: update the customer's lifetime stats and award points on the
 * money actually paid (loyalty redemptions and refunds excluded).
 */
export async function onOrderCompleted(
  tx: Tx,
  orderId: string,
  actorId: string | null,
) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { payments: true, refunds: true },
  });
  if (!order.customerId) return;
  const customer = await tx.customer.update({
    where: { id: order.customerId },
    data: {
      totalSpent: { increment: order.total },
      orderCount: { increment: 1 },
      lastOrderAt: new Date(),
    },
  });
  const profile = await tx.tenantProfile.findUnique({
    where: { tenantId: order.tenantId },
  });
  const rules = loyaltyRulesOf(profile?.loyaltyRules);
  const reward = (points: number, reason: string) =>
    postLoyalty(tx, {
      tenantId: order.tenantId,
      customerId: order.customerId!,
      type: 'EARN',
      points,
      orderId: order.id,
      reason,
      actorId,
    });
  // Every N-th completed order earns a fixed reward.
  if (rules.everyNth && customer.orderCount % rules.everyNth.n === 0)
    await reward(
      rules.everyNth.points,
      `${customer.orderCount}-xarid sovg‘asi`,
    );
  // Birthday gift once a year, on an order completed on the birthday.
  if (rules.birthdayPoints > 0 && customer.birthday) {
    const today = new Date(Date.now() + 5 * 3_600_000);
    const year = today.getUTCFullYear();
    if (
      customer.birthday.getUTCMonth() === today.getUTCMonth() &&
      customer.birthday.getUTCDate() === today.getUTCDate() &&
      !(await tx.loyaltyEntry.findFirst({
        where: {
          customerId: customer.id,
          reason: `Tug‘ilgan kun ${year}`,
        },
      }))
    )
      await reward(rules.birthdayPoints, `Tug‘ilgan kun ${year}`);
  }
  // Tier bonus is added to the base cashback rate.
  const rate =
    (profile?.loyaltyEarnBp ?? 0) +
    (ruleTier(rules, customer.totalSpent)?.bonusBp ?? 0);
  if (rate <= 0) return;
  const paidMoney =
    order.payments
      .filter((payment) => payment.method !== 'LOYALTY')
      .reduce((sum, payment) => sum + payment.amount, 0) -
    order.refunds
      .filter((refund) => refund.method !== 'LOYALTY')
      .reduce((sum, refund) => sum + refund.amount, 0);
  const points = Math.floor((Math.max(0, paidMoney) * rate) / 10_000);
  await postLoyalty(tx, {
    tenantId: order.tenantId,
    customerId: order.customerId,
    type: 'EARN',
    points,
    orderId: order.id,
    reason: `Buyurtma №${order.number}`,
    actorId,
  });
}
