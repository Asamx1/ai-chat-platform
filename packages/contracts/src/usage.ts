import { z } from 'zod';

/** Micro-USD cost: bigint or non-negative integer micro-dollars. */
export const CostMicrosSchema = z.union([z.bigint().nonnegative(), z.number().int().nonnegative()]);

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costMicros: CostMicrosSchema,
  model: z.string().min(1),
  providerKey: z.string().min(1),
});

export type Usage = z.infer<typeof UsageSchema>;
