import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import type { BillingCycle } from '../../generated/prisma/client.js';
import { audit } from '../audit/audit.js';

const DAY = 86_400_000;
// An invoice is due this many days after its period starts.
export const INVOICE_DUE_DAYS = 7;
// After the due date the subscription is PAST_DUE; after this grace it is suspended.
export const SUSPEND_AFTER_DAYS = 7;
// Never issue more than this many catch-up invoices in one run.
const MAX_CATCH_UP = 24;

export function addCycle(start: Date, cycle: BillingCycle): Date {
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (cycle === 'YEARLY' ? 12 : 1));
  return end;
}

export function priceFor(
  plan: { monthlyPrice: number; yearlyPrice: number },
  cycle: BillingCycle,
) {
  return cycle === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice;
}

/** Monthly recurring revenue contributed by one subscription (yearly spread over 12). */
export function monthlyValue(
  plan: { monthlyPrice: number; yearlyPrice: number },
  cycle: BillingCycle,
) {
  return cycle === 'YEARLY'
    ? Math.round(plan.yearlyPrice / 12)
    : plan.monthlyPrice;
}

/** Starts a trial on the given plan for a newly created tenant. */
export async function startTrial(
  tx: Tx,
  tenantId: string,
  planCode: string,
  now: Date,
) {
  const plan = await tx.plan.findFirst({
    where: { code: planCode, isActive: true },
  });
  if (!plan) return null;
  // Without a trial the opening period ends at once, so the next billing run
  // issues the first invoice immediately.
  const trialEnd = new Date(
    now.getTime() + (plan.trialDays > 0 ? plan.trialDays * DAY : 1000),
  );
  return tx.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: plan.trialDays > 0 ? 'TRIALING' : 'ACTIVE',
      trialEndsAt: plan.trialDays > 0 ? trialEnd : null,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
    },
  });
}

/**
 * Advances one subscription: issues invoices for elapsed periods, marks overdue
 * subscriptions PAST_DUE and suspends tenants whose invoices stay unpaid past the
 * grace period. Idempotent: invoices are unique per subscription and period start.
 */
async function advanceSubscription(tx: Tx, id: string, now: Date) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM subscriptions WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
  if (rows.length === 0) return;
  const subscription = await tx.subscription.findUniqueOrThrow({
    where: { id },
    include: { plan: true, tenant: true },
  });
  if (
    subscription.status === 'CANCELLED' ||
    subscription.tenant.status === 'CLOSED'
  )
    return;
  let { currentPeriodEnd, currentPeriodStart, status } = subscription;
  for (let i = 0; i < MAX_CATCH_UP && currentPeriodEnd <= now; i++) {
    const periodStart = currentPeriodEnd;
    const periodEnd = addCycle(periodStart, subscription.billingCycle);
    await tx.invoice.upsert({
      where: {
        subscriptionId_periodStart: {
          subscriptionId: subscription.id,
          periodStart,
        },
      },
      update: {},
      create: {
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        planCode: subscription.plan.code,
        periodStart,
        periodEnd,
        amount: priceFor(subscription.plan, subscription.billingCycle),
        status:
          priceFor(subscription.plan, subscription.billingCycle) === 0
            ? 'PAID'
            : 'OPEN',
        paidAt:
          priceFor(subscription.plan, subscription.billingCycle) === 0
            ? now
            : null,
        dueDate: new Date(periodStart.getTime() + INVOICE_DUE_DAYS * DAY),
      },
    });
    currentPeriodStart = periodStart;
    currentPeriodEnd = periodEnd;
    if (status === 'TRIALING') status = 'ACTIVE';
  }
  const oldestOpen = await tx.invoice.findFirst({
    where: { subscriptionId: subscription.id, status: 'OPEN' },
    orderBy: { dueDate: 'asc' },
  });
  let suspend = false;
  if (oldestOpen && oldestOpen.dueDate <= now) {
    if (
      oldestOpen.dueDate.getTime() + SUSPEND_AFTER_DAYS * DAY <=
      now.getTime()
    ) {
      status = 'SUSPENDED';
      suspend = subscription.tenant.status === 'ACTIVE';
    } else if (status !== 'SUSPENDED') status = 'PAST_DUE';
  }
  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status,
      currentPeriodStart,
      currentPeriodEnd,
      ...(suspend ? { suspendedForBilling: true } : {}),
    },
  });
  if (suspend) {
    await tx.tenant.update({
      where: { id: subscription.tenantId },
      data: { status: 'SUSPENDED' },
    });
    await audit(tx, null, {
      tenantId: subscription.tenantId,
      action: 'billing.tenant.suspend',
      entityType: 'subscription',
      entityId: subscription.id,
      data: { invoiceId: oldestOpen!.id },
    });
  }
}

export async function runBillingCycle(
  services: Services,
  options: { tenantId?: string } = {},
) {
  const now = services.now?.() ?? new Date();
  const due = await services.db.subscription.findMany({
    where: {
      status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'] },
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      OR: [
        { currentPeriodEnd: { lte: now } },
        { invoices: { some: { status: 'OPEN', dueDate: { lte: now } } } },
      ],
    },
    select: { id: true },
    take: 500,
  });
  for (const { id } of due)
    await services.db.$transaction((tx) => advanceSubscription(tx, id, now));
  return { processed: due.length };
}

/** Records payment of an invoice and restores service when nothing is overdue. */
export async function markInvoicePaid(
  tx: Tx,
  invoiceId: string,
  reference: string,
  now: Date,
) {
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== 'OPEN') return null;
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { status: 'PAID', paidAt: now, reference },
  });
  const subscription = await tx.subscription.findUniqueOrThrow({
    where: { id: invoice.subscriptionId },
  });
  const overdue = await tx.invoice.count({
    where: {
      subscriptionId: subscription.id,
      status: 'OPEN',
      dueDate: { lte: now },
    },
  });
  if (overdue === 0 && subscription.status !== 'CANCELLED') {
    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: subscription.status === 'TRIALING' ? 'TRIALING' : 'ACTIVE',
        suspendedForBilling: false,
      },
    });
    // Only lift suspensions that billing itself imposed.
    if (subscription.suspendedForBilling)
      await tx.tenant.updateMany({
        where: { id: subscription.tenantId, status: 'SUSPENDED' },
        data: { status: 'ACTIVE' },
      });
  }
  return invoice;
}

export function startBillingWorker(
  services: Services,
  intervalMs = 15 * 60_000,
) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runBillingCycle(services)
      .catch(() => services.logger.error('Billing worker iteration failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const first = setTimeout(tick, 10_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
