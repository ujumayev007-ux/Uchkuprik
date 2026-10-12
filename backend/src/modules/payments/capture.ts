import type { Services } from '../../context.js';
import type { Tx } from '../../db.js';
import type { PaymentProvider } from '../../generated/prisma/client.js';
import { addEvent, lockOrder, netPaid } from '../orders/engine.js';

export class CaptureError extends Error {
  constructor(
    readonly reason:
      'ORDER_NOT_FOUND' | 'ORDER_CLOSED' | 'ALREADY_PAID' | 'WRONG_AMOUNT',
  ) {
    super(reason);
  }
}

/** Amount an online payment must cover: the full outstanding balance. */
export async function payableOrder(tx: Tx, tenantId: string, orderId: string) {
  const order = await tx.order.findFirst({ where: { id: orderId, tenantId } });
  if (!order) throw new CaptureError('ORDER_NOT_FOUND');
  if (
    order.status === 'CANCELLED' ||
    order.status === 'COMPLETED' ||
    order.status === 'DRAFT'
  )
    throw new CaptureError('ORDER_CLOSED');
  const due = order.total - netPaid(order);
  if (due <= 0) throw new CaptureError('ALREADY_PAID');
  return { order, due };
}

/**
 * Records a provider-verified payment. Called only from authenticated provider
 * callbacks; never from client input. Locks the order, requires the exact due amount,
 * is idempotent per provider transaction, and auto-accepts a paid PENDING order.
 */
export async function captureProviderPayment(
  tx: Tx,
  services: Services,
  input: {
    tenantId: string;
    orderId: string;
    provider: PaymentProvider;
    externalId: string;
    amount: number;
  },
) {
  const key = `${input.provider.toLowerCase()}:${input.externalId}`;
  const existing = await tx.payment.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: input.tenantId,
        idempotencyKey: key,
      },
    },
  });
  if (existing) return existing;
  const order = await lockOrder(tx, input.tenantId, input.orderId);
  if (order.status === 'CANCELLED' || order.status === 'COMPLETED')
    throw new CaptureError('ORDER_CLOSED');
  const due = order.total - netPaid(order);
  if (due <= 0) throw new CaptureError('ALREADY_PAID');
  if (input.amount !== due) throw new CaptureError('WRONG_AMOUNT');
  const now = services.now?.() ?? new Date();
  const payment = await tx.payment.create({
    data: {
      tenantId: input.tenantId,
      branchId: order.branchId,
      orderId: order.id,
      shiftId: null,
      method: input.provider,
      amount: input.amount,
      reference: input.externalId,
      idempotencyKey: key,
      createdById: null,
    },
  });
  // Verified online payment: paid online orders are accepted automatically.
  const accept = order.status === 'PENDING';
  await tx.order.update({
    where: { id: order.id },
    data: {
      paidTotal: { increment: input.amount },
      version: { increment: 1 },
      ...(accept ? { status: 'PLACED', placedAt: now } : {}),
    },
  });
  await addEvent(tx, input.tenantId, order.id, null, 'payment', {
    paymentId: payment.id,
    method: input.provider,
    amount: input.amount,
    verifiedBy: 'provider',
  });
  if (accept)
    await addEvent(tx, input.tenantId, order.id, null, 'status', {
      from: 'PENDING',
      to: 'PLACED',
      source: 'paid_online',
    });
  return payment;
}

/** After a capture commits: print kitchen tickets and notify screens. */
export async function afterCapture(services: Services, orderId: string) {
  const order = await services.db.order.findUnique({ where: { id: orderId } });
  if (!order) return;
  await services.afterOrderChange?.(order.id);
  services.events?.publish({
    type: 'order.changed',
    tenantId: order.tenantId,
    branchId: order.branchId,
    orderId: order.id,
    number: order.number,
    status: order.status,
  });
}
