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
    }
  | {
      type: 'kitchen.changed';
      tenantId: string;
      branchId: string;
      orderId: string;
    }
  | { type: 'menu.changed'; tenantId: string };

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
