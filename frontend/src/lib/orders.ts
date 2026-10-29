import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'PLACED'
  | 'PREPARING'
  | 'READY'
  | 'SERVED'
  | 'COMPLETED'
  | 'CANCELLED';
export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
export type PaymentMethod =
  | 'CASH'
  | 'CARD'
  | 'LOYALTY'
  | 'CLICK'
  | 'PAYME'
  | 'UZUM'
  | 'QR'
  | 'OTHER'
  // Charged to a customer credit (nasiya) or hotel room account.
  | 'CREDIT';

export type OrderItem = {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  unitPrice: number;
  modifiers: { optionId: string; name: string; price: number }[];
  modifiersTotal: number;
  components?: { name: string; quantity: number }[];
  quantity: number;
  lineTotal: number;
  note: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  cancelReason: string | null;
  kitchenStatus?: 'QUEUED' | 'PREPARING' | 'READY' | 'SERVED';
  // Waiting for the cook to confirm the cancellation.
  cancelRequested?: { reason: string | null } | null;
};

export type Order = {
  id: string;
  branchId: string;
  number: number;
  businessDate: string;
  type: OrderType;
  channel: string;
  status: OrderStatus;
  customerId: string | null;
  couponId: string | null;
  table: { id: string; name: string } | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  note: string | null;
  subtotal: number;
  discountBp: number;
  discountFixed: number;
  discountTotal: number;
  discountReason: string | null;
  serviceChargeBp: number;
  serviceCharge: number;
  total: number;
  paidTotal: number;
  refundedTotal: number;
  due: number;
  createdAt: string;
  placedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  // Scheduled order / banquet (workflows 11 and 12).
  scheduledFor?: string | null;
  scheduleConfirmedAt?: string | null;
  guests?: number | null;
  eventName?: string | null;
  // What the zone's workflow allows (null: no workflow).
  workflow?: {
    zone: string;
    payment: string;
    advancePercent: number;
    scheduling: boolean;
  } | null;
  version?: number;
  kitchen?: {
    acceptedAt: string | null;
    rejectedAt: string | null;
    rejectReason: string | null;
  };
  items: OrderItem[];
  payments: {
    id: string;
    method: PaymentMethod;
    amount: number;
    tendered: number | null;
    change: number | null;
    reference: string | null;
    createdAt: string;
  }[];
  refunds: {
    id: string;
    paymentId: string;
    method: PaymentMethod;
    amount: number;
    reason: string;
    createdAt: string;
  }[];
};

export type ShiftSummary = {
  shift: {
    id: string;
    status: 'OPEN' | 'CLOSED';
    openedAt: string;
    closedAt: string | null;
    openingCash: number;
    countedCash: number | null;
    variance: number | null;
    closeNote: string | null;
  };
  payments: { method: PaymentMethod; amount: number; count: number }[];
  refunds: { method: PaymentMethod; amount: number; count: number }[];
  movements: {
    id: string;
    amount: number;
    reason: string;
    createdAt: string;
  }[];
  ordersPaid: number;
  totalPayments: number;
  totalRefunds: number;
  expectedCash: number;
};

export function useCurrentShift(enabled = true) {
  return useQuery({
    queryKey: ['shift', 'current'],
    queryFn: () =>
      api<{ shift: ShiftSummary | null }>('/shifts/current').then(
        (data) => data.shift,
      ),
    enabled,
  });
}

/**
 * A new random request key (UUID v4). A restaurant server is opened by its address on the
 * local network over plain http, where browsers do not offer crypto.randomUUID (it needs
 * https or localhost): the cash register would fail to draw its screen. getRandomValues
 * works everywhere.
 */
export const newKey = (): string => {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
