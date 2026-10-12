import type { Tx } from '../../db.js';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { AppError, errors } from '../../http/errors.js';
import { priceVariants } from '../menu/pricing.js';

/**
 * Central order engine shared by every channel (POS, waiter, QR, web, Telegram).
 * All amounts are integer so‘m and are computed here from server data only.
 */

export const transitions: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PLACED', 'CANCELLED'],
  // Online orders: approved by staff (PLACED) or rejected (CANCELLED).
  PENDING: ['PLACED', 'CANCELLED'],
  PLACED: ['PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'],
  PREPARING: ['READY', 'SERVED', 'COMPLETED'],
  // New items added to a ready/served order send it back to the kitchen.
  READY: ['PREPARING', 'SERVED', 'COMPLETED'],
  SERVED: ['PREPARING', 'READY', 'COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertTransition(from: OrderStatus, to: OrderStatus) {
  if (!transitions[from].includes(to))
    throw new AppError(409, 'INVALID_TRANSITION', 'invalidTransition', {
      from,
      to,
    });
}

/** Orders whose content may still change (items, discount, table). */
export const editableStatuses: OrderStatus[] = [
  'DRAFT',
  'PENDING',
  'PLACED',
  'PREPARING',
  'READY',
  'SERVED',
];

export type ItemInput = {
  variantId: string;
  quantity: number;
  modifierOptionIds: string[];
  note?: string | null | undefined;
};

export type PricedItem = {
  variantId: string;
  productName: string;
  variantName: string;
  unitPrice: number;
  unitCost: number | null;
  stationId: string | null;
  prepTimeMinutes: number | null;
  modifiers: {
    optionId: string;
    groupId: string;
    name: string;
    price: number;
  }[];
  modifiersTotal: number;
  quantity: number;
  lineTotal: number;
  note: string | null;
};

/** Prices items for a branch and validates modifier selections against menu rules. */
export async function priceItems(
  tx: Tx,
  tenantId: string,
  branchId: string,
  items: ItemInput[],
): Promise<PricedItem[]> {
  const variantIds = [...new Set(items.map((item) => item.variantId))];
  const prices = await priceVariants(tx, tenantId, branchId, variantIds);
  const productIds = [
    ...new Set([...prices.values()].map((price) => price.productId)),
  ];
  const links = await tx.productModifierGroup.findMany({
    where: { tenantId, productId: { in: productIds } },
    include: { group: { include: { options: true } } },
  });
  return items.map((item, index) => {
    const price = prices.get(item.variantId);
    if (!price || !price.available)
      throw new AppError(409, 'ITEM_UNAVAILABLE', 'itemUnavailable', { index });
    const groups = links
      .filter(
        (link) => link.productId === price.productId && link.group.isActive,
      )
      .map((link) => link.group);
    const chosen = [...new Set(item.modifierOptionIds)];
    const modifiers: PricedItem['modifiers'] = [];
    for (const optionId of chosen) {
      const group = groups.find((candidate) =>
        candidate.options.some((option) => option.id === optionId),
      );
      const option = group?.options.find(
        (candidate) => candidate.id === optionId,
      );
      if (!group || !option || !option.isActive)
        throw new AppError(400, 'INVALID_MODIFIERS', 'invalidModifiers', {
          index,
        });
      modifiers.push({
        optionId,
        groupId: group.id,
        name: option.name,
        price: option.price,
      });
    }
    for (const group of groups) {
      const count = modifiers.filter(
        (modifier) => modifier.groupId === group.id,
      ).length;
      if (count < group.minSelect || count > group.maxSelect)
        throw new AppError(400, 'INVALID_MODIFIERS', 'invalidModifiers', {
          index,
          groupId: group.id,
        });
    }
    const modifiersTotal = modifiers.reduce(
      (sum, modifier) => sum + modifier.price,
      0,
    );
    return {
      variantId: item.variantId,
      productName: price.productName,
      variantName: price.variantName,
      unitPrice: price.price,
      unitCost: price.cost,
      stationId: price.stationId,
      prepTimeMinutes: price.prepTimeMinutes,
      modifiers,
      modifiersTotal,
      quantity: item.quantity,
      lineTotal: (price.price + modifiersTotal) * item.quantity,
      note: item.note?.trim() || null,
    };
  });
}

export function itemCreateData(
  tenantId: string,
  orderId: string,
  actorId: string | null,
  item: PricedItem,
) {
  return {
    tenantId,
    orderId,
    variantId: item.variantId,
    productName: item.productName,
    variantName: item.variantName,
    unitPrice: item.unitPrice,
    unitCost: item.unitCost,
    stationId: item.stationId,
    prepTimeMinutes: item.prepTimeMinutes,
    modifiers: item.modifiers as unknown as Prisma.InputJsonValue,
    modifiersTotal: item.modifiersTotal,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    note: item.note,
    createdById: actorId,
  };
}

/** Serializes concurrent changes (payments, edits) to one order. */
export async function lockOrder(tx: Tx, tenantId: string, orderId: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
  const order = await tx.order.findFirst({ where: { id: orderId, tenantId } });
  if (!order) throw errors.notFound();
  return order;
}

export function computeTotals(input: {
  subtotal: number;
  discountBp: number;
  discountFixed: number;
  serviceChargeBp: number;
  // Delivery fee is added after discounts and is not subject to service charge.
  deliveryFee?: number;
}) {
  const discountTotal = Math.min(
    input.subtotal,
    input.discountFixed +
      Math.round((input.subtotal * input.discountBp) / 10_000),
  );
  const serviceCharge = Math.round(
    ((input.subtotal - discountTotal) * input.serviceChargeBp) / 10_000,
  );
  return {
    discountTotal,
    serviceCharge,
    total:
      input.subtotal - discountTotal + serviceCharge + (input.deliveryFee ?? 0),
  };
}

/** Recomputes totals from active items; rejects changes that would leave the order overpaid. */
export async function recalculate(tx: Tx, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const aggregate = await tx.orderItem.aggregate({
    where: { orderId, status: 'ACTIVE' },
    _sum: { lineTotal: true },
  });
  const subtotal = aggregate._sum.lineTotal ?? 0;
  const totals = computeTotals({ ...order, subtotal });
  if (order.paidTotal - order.refundedTotal > totals.total)
    throw new AppError(409, 'OVERPAID', 'overpaid');
  return tx.order.update({
    where: { id: orderId },
    data: { subtotal, ...totals, version: { increment: 1 } },
  });
}

export async function addEvent(
  tx: Tx,
  tenantId: string,
  orderId: string,
  actorId: string | null,
  type: string,
  data?: Prisma.InputJsonValue,
) {
  await tx.orderEvent.create({
    data: {
      tenantId,
      orderId,
      actorId,
      type,
      ...(data === undefined ? {} : { data }),
    },
  });
}

/** Calendar date in the branch's timezone; order numbers restart daily. */
export function businessDate(now: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${parts}T00:00:00.000Z`);
}

export async function nextOrderNumber(
  tx: Tx,
  branchId: string,
  date: Date,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO order_counters ("branchId", "businessDate", "lastNumber")
    VALUES (${branchId}::uuid, ${date}::date, 1)
    ON CONFLICT ("branchId", "businessDate")
    DO UPDATE SET "lastNumber" = order_counters."lastNumber" + 1
    RETURNING "lastNumber"`;
  return rows[0]!.lastNumber;
}

export const netPaid = (order: { paidTotal: number; refundedTotal: number }) =>
  order.paidTotal - order.refundedTotal;

const kitchenStatuses: OrderStatus[] = [
  'PLACED',
  'PREPARING',
  'READY',
  'SERVED',
];

/**
 * Derives the order status from its items' kitchen progress:
 * any item started -> PREPARING; all items ready -> READY; new unfinished items on a
 * READY/SERVED order -> PREPARING. Call inside the transaction that changed items.
 */
export async function syncKitchenStatus(tx: Tx, orderId: string, now: Date) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!kitchenStatuses.includes(order.status)) return order.status;
  const items = await tx.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    select: { kitchenStatus: true },
  });
  if (items.length === 0) return order.status;
  const done = items.every(
    (item) => item.kitchenStatus === 'READY' || item.kitchenStatus === 'SERVED',
  );
  const allServed = items.every((item) => item.kitchenStatus === 'SERVED');
  const started = items.some((item) => item.kitchenStatus !== 'QUEUED');
  let next: OrderStatus = order.status;
  if (order.status === 'SERVED')
    next = allServed ? 'SERVED' : done ? 'READY' : 'PREPARING';
  else if (done) next = 'READY';
  else if (started || order.status === 'READY') next = 'PREPARING';
  if (next === order.status) return next;
  assertTransition(order.status, next);
  await tx.order.update({
    where: { id: orderId },
    data: {
      status: next,
      version: { increment: 1 },
      ...(next === 'READY' ? { readyAt: now } : {}),
    },
  });
  await addEvent(tx, order.tenantId, orderId, null, 'status', {
    from: order.status,
    to: next,
    source: 'kitchen',
  });
  return next;
}
