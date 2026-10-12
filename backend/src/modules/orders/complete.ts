import type { Tx } from '../../db.js';
import { AppError } from '../../http/errors.js';
import { onOrderCompleted } from '../crm/loyalty.js';
import { consumeOrderIngredients } from '../inventory/ledger.js';
import { recordFiscalReceipt } from '../payments/fiscal.js';
import { addEvent, assertTransition, netPaid } from './engine.js';

/**
 * Completes a locked order: requires full payment, deducts recipe ingredients,
 * records the fiscal status and updates the customer's loyalty — all in the caller's
 * transaction. Used by the cashier ("Berildi") and by couriers on delivery.
 */
export async function completeOrder(
  tx: Tx,
  order: {
    id: string;
    tenantId: string;
    status: Parameters<typeof assertTransition>[0];
    total: number;
    paidTotal: number;
    refundedTotal: number;
  },
  actorId: string | null,
  now: Date,
) {
  assertTransition(order.status, 'COMPLETED');
  if (netPaid(order) < order.total)
    throw new AppError(409, 'NOT_FULLY_PAID', 'notFullyPaid');
  await consumeOrderIngredients(tx, order.id, actorId);
  await recordFiscalReceipt(tx, order.tenantId, order.id);
  await onOrderCompleted(tx, order.id, actorId);
  await tx.order.update({
    where: { id: order.id },
    data: { status: 'COMPLETED', completedAt: now, version: { increment: 1 } },
  });
  await addEvent(tx, order.tenantId, order.id, actorId, 'status', {
    from: order.status,
    to: 'COMPLETED',
  });
}
