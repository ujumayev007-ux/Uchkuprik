import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext } from '../auth/session.js';
import { orderFlow } from '../workflow/restaurant.js';
import { netPaid } from './engine.js';

/** An order as the API returns it (costs only for those allowed to see them). */
export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: { items: true; payments: true; refunds: true; table: true };
}>;

export function serialize(
  order: OrderWithRelations,
  auth: Pick<AuthContext, 'permissions' | 'financial' | 'reportFields'>,
) {
  const showCost =
    auth.permissions.has('finance.view') &&
    auth.financial.cost &&
    auth.reportFields.cost;
  return {
    id: order.id,
    branchId: order.branchId,
    number: order.number,
    businessDate: order.businessDate.toISOString().slice(0, 10),
    type: order.type,
    channel: order.channel,
    status: order.status,
    table: order.table ? { id: order.table.id, name: order.table.name } : null,
    customerId: order.customerId,
    couponId: order.couponId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    deliveryLandmark: order.deliveryLandmark,
    note: order.note,
    subtotal: order.subtotal,
    discountBp: order.discountBp,
    discountFixed: order.discountFixed,
    discountTotal: order.discountTotal,
    discountReason: order.discountReason,
    serviceChargeBp: order.serviceChargeBp,
    serviceCharge: order.serviceCharge,
    total: order.total,
    paidTotal: order.paidTotal,
    refundedTotal: order.refundedTotal,
    due: Math.max(0, order.total - netPaid(order)),
    version: order.version,
    createdAt: order.createdAt,
    placedAt: order.placedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    scheduledFor: order.scheduledFor,
    scheduleConfirmedAt: order.scheduleConfirmedAt,
    guests: order.guests,
    eventName: order.eventName,
    // What the zone's workflow allows for this order (null: no workflow).
    workflow: (() => {
      const flow = orderFlow(order);
      return flow
        ? {
            zone: flow.zone,
            payment: flow.payment,
            advancePercent: flow.advancePercent,
            scheduling: flow.scheduling,
          }
        : null;
    })(),
    kitchen: {
      acceptedAt: order.kitchenAcceptedAt,
      rejectedAt: order.kitchenRejectedAt,
      rejectReason: order.kitchenRejectReason,
    },
    items: order.items
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((item) => ({
        id: item.id,
        variantId: item.variantId,
        productName: item.productName,
        variantName: item.variantName,
        unitPrice: item.unitPrice,
        modifiers: item.modifiers,
        modifiersTotal: item.modifiersTotal,
        components: item.components,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        note: item.note,
        status: item.status,
        cancelReason: item.cancelReason,
        kitchenStatus: item.kitchenStatus,
        cancelRequested: item.cancelRequestedAt
          ? { reason: item.cancelRequestReason }
          : null,
        ...(showCost ? { unitCost: item.unitCost } : {}),
      })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amount: payment.amount,
      tendered: payment.tendered,
      change: payment.change,
      reference: payment.reference,
      createdAt: payment.createdAt,
    })),
    refunds: order.refunds.map((refund) => ({
      id: refund.id,
      paymentId: refund.paymentId,
      method: refund.method,
      amount: refund.amount,
      reason: refund.reason,
      createdAt: refund.createdAt,
    })),
  };
}
