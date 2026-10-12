import type { Db } from '../../db.js';
import type { AuthContext } from '../auth/session.js';

const DAY = 86_400_000;

/** Billing status shown to tenant managers as a reminder banner. */
export async function billingNotice(db: Db, auth: AuthContext, now: Date) {
  if (
    auth.tenantKind !== 'BUSINESS' ||
    !auth.permissions.has('settings.manage')
  )
    return null;
  const subscription = await db.subscription.findUnique({
    where: { tenantId: auth.tenantId },
    include: {
      invoices: {
        where: { status: 'OPEN' },
        orderBy: { dueDate: 'asc' },
        take: 1,
      },
    },
  });
  if (!subscription) return null;
  const open = subscription.invoices[0];
  return {
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
    trialDaysLeft:
      subscription.status === 'TRIALING' && subscription.trialEndsAt
        ? Math.max(
            0,
            Math.ceil(
              (subscription.trialEndsAt.getTime() - now.getTime()) / DAY,
            ),
          )
        : null,
    openInvoice: open ? { amount: open.amount, dueDate: open.dueDate } : null,
  };
}
