import { z } from 'zod';

/**
 * Restaurant loyalty rules on top of the base cashback rate (loyaltyEarnBp):
 * spend-based tiers with an extra earn rate, a reward every N completed orders and a
 * yearly birthday gift. Unknown or missing fields fall back to "off".
 */
export const loyaltyRulesSchema = z.object({
  tiers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(30),
        // Lifetime spend (so‘m) from which the tier applies.
        minSpent: z.number().int().min(0).max(10_000_000_000),
        // Extra earn rate in basis points (100 = +1%).
        bonusBp: z.number().int().min(0).max(5000),
      }),
    )
    .max(6)
    .default([]),
  everyNth: z
    .object({
      n: z.number().int().min(2).max(100),
      points: z.number().int().min(1).max(10_000_000),
    })
    .nullable()
    .default(null),
  birthdayPoints: z.number().int().min(0).max(10_000_000).default(0),
  // Referral: both get points on the new customer's first completed order.
  referrerPoints: z.number().int().min(0).max(10_000_000).default(0),
  referredPoints: z.number().int().min(0).max(10_000_000).default(0),
});
export type LoyaltyRules = z.infer<typeof loyaltyRulesSchema>;

export function loyaltyRulesOf(value: unknown): LoyaltyRules {
  const parsed = loyaltyRulesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : loyaltyRulesSchema.parse({});
}

/** Highest tier whose threshold the customer reached (tiers in any order). */
export function ruleTier(rules: LoyaltyRules, totalSpent: number) {
  return (
    [...rules.tiers]
      .sort((a, b) => b.minSpent - a.minSpent)
      .find((tier) => totalSpent >= tier.minSpent) ?? null
  );
}
