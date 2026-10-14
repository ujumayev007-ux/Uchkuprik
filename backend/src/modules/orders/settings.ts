import { z } from 'zod';
import type { Db, Tx } from '../../db.js';

/**
 * Per-restaurant order workflow settings (TenantProfile.orderSettings). Unknown or
 * missing fields fall back to these defaults, so older rows keep working.
 */
export const orderSettingsSchema = z.object({
  // Waiter orders wait for cashier confirmation (PENDING) before reaching the kitchen.
  requireCashierConfirm: z.boolean().default(false),
  // Show selling prices on kitchen tickets.
  kitchenPrices: z.boolean().default(false),
  // Waiters may add/cancel items after the order was sent to the kitchen.
  waiterCanEditPlaced: z.boolean().default(true),
  // Delivery handoff and delivery confirmation with one-time codes.
  deliveryCodes: z.boolean().default(true),
  // Staff without the cancel permission may cancel/reduce sent items (revenue risk).
  staffCanCancelPlaced: z.boolean().default(false),
  // Cancelling an item that the kitchen is already preparing needs kitchen
  // acknowledgement or a manager override.
  cancelPreparingNeedsAck: z.boolean().default(true),
});

export type OrderSettings = z.infer<typeof orderSettingsSchema>;

export function orderSettingsOf(value: unknown): OrderSettings {
  const parsed = orderSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : orderSettingsSchema.parse({});
}

/**
 * Settings the vendor locked for this install through the licence. Locked values win
 * over the restaurant's own choice and cannot be edited by the restaurant.
 */
let lockedOrderSettings: Partial<OrderSettings> = {};

export function setLockedOrderSettings(value: unknown) {
  const parsed = orderSettingsSchema.partial().safeParse(value ?? {});
  lockedOrderSettings = parsed.success
    ? Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined),
      )
    : {};
}

export function lockedOrderSettingKeys() {
  return Object.keys(lockedOrderSettings) as (keyof OrderSettings)[];
}

/**
 * Status for an order being sent to the kitchen: PENDING (waits for the cashier) when
 * the restaurant requires confirmation and the sender cannot take payments.
 */
export async function placementStatus(
  db: Tx | Db,
  tenantId: string,
  permissions: Set<string>,
): Promise<'PLACED' | 'PENDING'> {
  if (permissions.has('payments.accept')) return 'PLACED';
  return (await loadOrderSettings(db, tenantId)).requireCashierConfirm
    ? 'PENDING'
    : 'PLACED';
}

export async function loadOrderSettings(
  db: Tx | Db,
  tenantId: string,
): Promise<OrderSettings> {
  const profile = await db.tenantProfile.findUnique({
    where: { tenantId },
    select: { orderSettings: true },
  });
  return { ...orderSettingsOf(profile?.orderSettings), ...lockedOrderSettings };
}
