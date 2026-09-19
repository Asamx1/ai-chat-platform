import { z } from 'zod';

/**
 * M6-C1: Run result schema — one row per (manifest, condition, repeat, sample).
 * Persisted by the batch runner's ProgressStore for resume and analysis.
 */

export const RunStatus = z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunResultSchema = z.object({
  manifestId: z.string().min(1),
  conditionId: z.string().min(1),
  repeat: z.number().int().nonnegative(),
  sampleId: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  status: RunStatus,
  output: z
    .object({
      text: z.string(),
      usage: z.object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().nonnegative(),
        costMicros: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  metrics: z
    .object({
      ttftMs: z.number().nonnegative(),
      totalMs: z.number().nonnegative(),
    })
    .optional(),
  error: z.string().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;
