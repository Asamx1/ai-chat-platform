import { z } from 'zod';
import { parseDocument } from 'yaml';
import type { Ontology, Constraints, InferenceRules } from './types.js';
const text = z.string().trim().min(1);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
export const ontologySchema = z.strictObject({
  version,
  classes: z.array(z.strictObject({ id: text, label: text, description: text, abstract: z.boolean() })).min(1),
  endpointRoles: z.array(text),
  relations: z.array(z.strictObject({ id: text, label: text, description: text,
    domain: z.array(text).min(1), range: z.array(text).min(1), symmetric: z.boolean(),
    transitive: z.boolean(), requiresContext: z.boolean(), inverseOf: text.optional() })).min(1),
  aliases: z.strictObject({ fields: z.array(text).min(1), resolutionOrder: z.array(text).min(1), similarityMayMerge: z.literal(false) }),
}).superRefine((o, ctx) => {
  const ids = [...o.classes.map(c => c.id), ...o.endpointRoles];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate class/role ID' });
  if (new Set(o.relations.map(r => r.id)).size !== o.relations.length) ctx.addIssue({ code: 'custom', message: 'Duplicate relation ID' });
  for (const r of o.relations) {
    if ([...r.domain, ...r.range].some(t => !ids.includes(t))) ctx.addIssue({ code: 'custom', message: `Unknown endpoint type: ${r.id}` });
    if (r.inverseOf) {
      const inverse = o.relations.find(i => i.id === r.inverseOf);
      if (!inverse || inverse.inverseOf !== r.id || r.domain.some(t => !inverse.range.includes(t)) || r.range.some(t => !inverse.domain.includes(t)))
        ctx.addIssue({ code: 'custom', message: `Invalid reciprocal inverse: ${r.id}` });
    }
  }
});
export const requiredAssertionFields = ['id', 'subject', 'predicate', 'polarity', 'context', 'validTime', 'status', 'evidence', 'origin', 'ruleVersion', 'revision'];
export const numericFields = ['unit', 'dataset', 'testSettings', 'metric'];
export const constraintsSchema = z.strictObject({ version,
  requiredFields: z.array(text).refine(v => requiredAssertionFields.every(f => v.includes(f)), 'Missing mandatory assertion fields'),
  numericRequiredFields: z.array(text).refine(v => numericFields.every(f => v.includes(f)), 'Missing mandatory numeric fields'),
  objectOrValue: z.literal('exactlyOne'), origins: z.tuple([z.literal('sourced'), z.literal('inferred')]),
  endpointTypes: z.literal(true), forbidSubclassCycles: z.literal(true), evidenceTargetsAssertion: z.literal(true),
});
export const inferenceRulesSchema = z.strictObject({ version, maxDepth: z.number().int().min(1).max(100),
  rules: z.array(z.strictObject({ ruleId: z.enum(['R-SUBCLASS-TRANS', 'R-INVERSE-DECLARED']), ruleVersion: version,
    description: text, premises: z.array(text).min(1), approved: z.literal(true) }))
    .refine(r => new Set(r.map(x => x.ruleId)).size === r.length, 'Duplicate rule ID'),
  forbidden: z.array(text).min(1),
});
export const assertionSchema = z.object({
  id: text, subject: z.object({ id: text, type: text }), predicate: text,
  object: z.object({ id: text, type: text }).optional(), value: z.union([text, z.number().finite(), z.boolean()]).optional(),
  polarity: z.enum(['positive', 'negative']), context: z.record(z.string(), z.unknown()),
  validTime: z.object({ from: text.nullable(), to: text.nullable() }),
  status: z.enum(['candidate', 'supported', 'contested', 'superseded', 'invalid']),
  evidence: z.array(z.object({ sourceId: text, sourceVersion: text, locator: text, excerpt: text, relation: z.enum(['supports', 'contradicts']) })),
  origin: z.enum(['sourced', 'inferred']), ruleVersion: version, revision: z.number().int().positive(),
  unit: text.optional(), dataset: text.optional(), testSettings: z.record(z.string(), z.unknown()).optional(), metric: text.optional(),
  ruleId: z.enum(['R-SUBCLASS-TRANS', 'R-INVERSE-DECLARED']).optional(),
  premiseAssertionIds: z.array(text).min(1).optional(), depth: z.number().int().positive().optional(), withdrawn: z.boolean().optional(),
}).superRefine((a, ctx) => {
  if ((a.object === undefined) === (a.value === undefined)) ctx.addIssue({ code: 'custom', message: 'Exactly one of object or value is required' });
  if (a.origin === 'inferred' && (!a.ruleId || !a.premiseAssertionIds)) ctx.addIssue({ code: 'custom', message: 'Inferred assertions require ruleId and premiseAssertionIds' });
});
export class SchemaLoadError extends Error {
  constructor(public readonly code: string, message?: string) { super(message ?? code); this.name = 'SchemaLoadError'; }
}
function load<T>(input: string, schema: z.ZodType<T>, name: string): T {
  try {
    const doc = parseDocument(input, { uniqueKeys: true });
    if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('; '));
    const result = schema.safeParse(doc.toJS({ maxAliasCount: 50 }));
    if (!result.success) throw new Error(result.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '));
    return result.data;
  } catch (error) { throw new SchemaLoadError('INVALID_SCHEMA', `${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
// Cast removes Zod's explicit optional undefined; YAML defaults contain no undefined values.
export const loadOntology = (input: string): Ontology => load(input, ontologySchema, 'ontology') as Ontology;
export const loadConstraints = (input: string): Constraints => load(input, constraintsSchema, 'constraints');
export const loadInferenceRules = (input: string): InferenceRules => load(input, inferenceRulesSchema, 'inference-rules');
