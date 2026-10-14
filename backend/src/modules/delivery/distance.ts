import { z } from 'zod';
import type { Tx } from '../../db.js';
import { AppError, errors } from '../../http/errors.js';
import { recalculate } from '../orders/engine.js';

/**
 * Distance-based delivery fee. Straight-line distance from the branch to the
 * customer is multiplied by a road factor (streets are not straight), then priced as
 * base + per km, never below the minimum. Orders above `freeFrom` deliver free.
 */
export const deliveryPricingSchema = z.object({
  enabled: z.boolean().default(false),
  baseFee: z.number().int().min(0).max(10_000_000).default(0),
  perKm: z.number().int().min(0).max(10_000_000).default(0),
  minFee: z.number().int().min(0).max(10_000_000).default(0),
  // Farther points are refused (0 = no limit).
  maxKm: z.number().min(0).max(500).default(0),
  // Subtotal from which delivery is free (0 = never).
  freeFrom: z.number().int().min(0).max(1_000_000_000).default(0),
  roadFactor: z.number().min(1).max(3).default(1.3),
});
export type DeliveryPricing = z.infer<typeof deliveryPricingSchema>;

export function deliveryPricingOf(value: unknown): DeliveryPricing {
  const parsed = deliveryPricingSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : deliveryPricingSchema.parse({});
}

export const latitude = z.number().min(-90).max(90);
export const longitude = z.number().min(-180).max(180);

/** Great-circle distance in metres (haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function priceForDistance(
  pricing: DeliveryPricing,
  meters: number,
  subtotal: number,
) {
  if (pricing.freeFrom > 0 && subtotal >= pricing.freeFrom) return 0;
  const km = meters / 1000;
  // Rounded up to the next 100 so‘m.
  const fee = Math.ceil((pricing.baseFee + km * pricing.perKm) / 100) * 100;
  return Math.max(pricing.minFee, fee);
}

/**
 * Stores the customer's point on a delivery order and, when distance pricing is on
 * and the branch has a location, replaces the zone fee with the distance fee.
 */
export async function applyDeliveryLocation(
  tx: Tx,
  tenantId: string,
  orderId: string,
  point: { lat: number; lng: number },
) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.type !== 'DELIVERY') throw errors.validation([{ path: 'lat' }]);
  const [branch, profile] = await Promise.all([
    tx.branch.findUniqueOrThrow({ where: { id: order.branchId } }),
    tx.tenantProfile.findUnique({ where: { tenantId } }),
  ]);
  const pricing = deliveryPricingOf(profile?.deliveryPricing);
  const priced = pricing.enabled && branch.lat !== null && branch.lng !== null;
  const meters = priced
    ? Math.round(
        distanceMeters({ lat: branch.lat!, lng: branch.lng! }, point) *
          pricing.roadFactor,
      )
    : null;
  if (meters !== null && pricing.maxKm > 0 && meters > pricing.maxKm * 1000)
    throw new AppError(400, 'OUT_OF_RANGE', 'deliveryOutOfRange', {
      km: Math.round(meters / 100) / 10,
      maxKm: pricing.maxKm,
    });
  await tx.order.update({
    where: { id: orderId },
    data: {
      deliveryLat: point.lat,
      deliveryLng: point.lng,
      deliveryDistanceM: meters,
      ...(meters !== null
        ? {
            deliveryZoneId: null,
            deliveryFee: priceForDistance(pricing, meters, order.subtotal),
          }
        : {}),
    },
  });
  return recalculate(tx, orderId);
}

/** Finds "lat,lng" in free text or a map link (Google ?q=, plain pairs). */
export function parsePoint(text: string): { lat: number; lng: number } | null {
  const match = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
