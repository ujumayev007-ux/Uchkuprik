import { EventEmitter } from 'node:events';

/**
 * Real-time notifications. Payloads identify what changed and never contain prices,
 * costs or customer data; clients refetch authorized details over the REST API.
 * The in-process bus serves one API instance; a Redis-backed bus replaces it when
 * the API scales horizontally.
 */
export type RealtimeEvent =
  | {
      type: 'order.changed';
      tenantId: string;
      branchId: string;
      orderId: string;
      number: number;
      status: string;
      // Set when the kitchen accepted, refused or got the order again.
      kitchen?: 'ACCEPTED' | 'REJECTED' | 'REOPENED';
    }
  | {
      type: 'kitchen.changed';
      tenantId: string;
      branchId: string;
      orderId: string;
    }
  | {
      type: 'order.updated';
      tenantId: string;
      branchId: string;
      orderId: string;
      number: number;
      version: number;
    }
  | {
      // A guest was taken without a table: waiters assign one.
      type: 'order.table_needed';
      tenantId: string;
      branchId: string;
      orderId: string;
      number: number;
      byUserId: string | null;
    }
  | {
      type: 'order.table_assigned';
      tenantId: string;
      branchId: string;
      orderId: string;
      number: number;
      byUserId: string | null;
    }
  | {
      // The kitchen marked dishes ready: only the order's waiter is told.
      type: 'order.items_ready';
      tenantId: string;
      branchId: string;
      orderId: string;
      number: number;
      table: string | null;
      waiterId: string | null;
      items: { id: string; name: string; quantity: number }[];
      // Every active dish of the order is ready now.
      allReady: boolean;
    }
  // Owner or Admin changed settings: panels and Android devices reload them.
  | { type: 'config.changed'; tenantId: string }
  // Owner (or delegated Admin) changed the design or advertising: screens reload it.
  | { type: 'branding.changed'; tenantId: string }
  | { type: 'menu.changed'; tenantId: string }
  | { type: 'inventory.changed'; tenantId: string };

export interface EventBus {
  publish(event: RealtimeEvent): void;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return {
    publish(event) {
      emitter.emit('event', event);
    },
    subscribe(listener) {
      emitter.on('event', listener);
      return () => emitter.off('event', listener);
    },
  };
}

export const branchRoom = (tenantId: string, branchId: string) =>
  `t:${tenantId}:b:${branchId}`;
export const tenantRoom = (tenantId: string) => `t:${tenantId}`;
// One person's open screens (ready dishes go only to the order's waiter).
export const userRoom = (tenantId: string, userId: string) =>
  `t:${tenantId}:u:${userId}`;
