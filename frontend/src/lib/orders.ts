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
  'CASH' | 'CARD' | 'LOYALTY' | 'CLICK' | 'PAYME' | 'UZUM' | 'OTHER';

export type OrderItem = {
  id: string;
  variantId: string;
  productName: string;
  variantName: string;
  unitPrice: number;
  modifiers: { optionId: string; name: string; price: number }[];
  modifiersTotal: number;
  quantity: number;
  lineTotal: number;
  note: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  cancelReason: string | null;
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

export const newKey = () => crypto.randomUUID();
