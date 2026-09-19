import { z } from 'zod';

/**
 * M6-C1: Experiment manifest schema.
 *
 * A manifest fully describes one experiment batch: conditions to compare,
 * the dataset slice to run against, budget guardrails, and repeat/seed for
 * reproducibility. Kept as a pure Zod schema so both the batch runner and
 * orchestration tests can validate manifests without I/O.
 */

export const ConditionKind = z.enum([
  'SINGLE',
  'SELF_CONSISTENCY_K',
  'PARALLEL_HETERO',
  'CONSENSUS',
  'DEBATE',
]);
export type ConditionKind = z.infer<typeof ConditionKind>;

export const HashSchema = z.string().regex(/^[a-f0-9]{16,64}$/, 'hash must be lowercase hex, 16-64 chars');

export const ConditionSchema = z.object({
  id: z.string().min(1),
  kind: ConditionKind,
  params: z.record(z.string(), z.unknown()),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const ExperimentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  conditions: z.array(ConditionSchema).min(1),
  dataset: z.object({
    path: z.string().min(1),
    hash: HashSchema,
  }),
  budget: z.object({
    maxTokensPerRun: z.number().int().nonnegative(),
    maxTotalUsdMicros: z.number().int().nonnegative(),
  }),
  repeats: z.number().int().min(1),
  seed: z.number().int(),
  models: z.array(
    z.object({
      key: z.string().min(1),
      provider: z.string().min(1),
      version: z.string().min(1),
    }),
  ),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;

/** Parse a manifest or throw the underlying ZodError. */
export function validateManifest(obj: unknown): ExperimentManifest {
  return ExperimentManifestSchema.parse(obj);
}
