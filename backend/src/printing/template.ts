import { z } from 'zod';

/** Per-department kitchen ticket layout (KitchenStation.ticketTemplate). */
export const ticketTemplateSchema = z.object({
  header: z.string().trim().max(60).default(''),
  footer: z.string().trim().max(80).default(''),
  // Items in double-height letters (easier to read from a distance).
  largeItems: z.boolean().default(true),
  showWaiter: z.boolean().default(true),
  showNotes: z.boolean().default(true),
  copies: z.number().int().min(1).max(3).default(1),
});
export type TicketTemplate = z.infer<typeof ticketTemplateSchema>;

export function ticketTemplateOf(value: unknown): TicketTemplate {
  const parsed = ticketTemplateSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : ticketTemplateSchema.parse({});
}
