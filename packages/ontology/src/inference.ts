import { assertionSchema, inferenceRulesSchema } from './load.js';
import { createsSubclassCycle, checkRelationEdge } from './check.js';
import { defaultOntology } from './registry.js';
import type { Assertion, InferenceOptions, InferenceResult, InferenceRules, InferenceRule } from './types.js';
// Stable ordering prevents object insertion order from changing scope/edge identity.
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}
const scope = (a: Assertion) => stable([a.context, a.validTime]);
const key = (a: Assertion) => stable([a.subject, a.predicate, a.object, a.polarity, a.context, a.validTime]);
const usable = (a: Assertion) => a.status === 'supported' && !a.withdrawn && a.polarity === 'positive' && !!a.object;
function bound(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`${name} must be an integer in 1..100`);
  return value;
}
export function runInference(input: readonly Assertion[], rules: InferenceRules, options: InferenceOptions = {}): InferenceResult {
  const validated = inferenceRulesSchema.parse(rules); // No evaluation of free-form premise/description strings.
  const maxDepth = bound(options.maxDepth ?? validated.maxDepth, 'maxDepth');
  const maxRounds = bound(options.maxRounds ?? 5, 'maxRounds');
  const ontology = options.ontology ?? defaultOntology;
  // Recompute from sourced records; never trust persisted derived records as roots.
  const assertions = structuredClone(input.filter(a => a.origin === 'sourced')) as Assertion[];
  if (new Set(input.map(a => a.id)).size !== input.length) throw new Error('Duplicate assertion ID');
  for (const a of assertions) {
    assertionSchema.parse(a);
    const relation = ontology.relations.find(r => r.id === a.predicate);
    if (usable(a) && relation?.requiresContext && Object.keys(a.context).length === 0) throw new Error(`Missing relation context: ${a.id}`);
    if (createsSubclassCycle(a, assertions)) throw new Error(`Subclass cycle: ${a.id}`);
    if (usable(a) && a.object && checkRelationEdge(a.subject.type, a.predicate, a.object.type, ontology).length) throw new Error(`Invalid relation endpoints: ${a.id}`);
  }
  const derived: Assertion[] = [];
  const seen = new Set(assertions.filter(usable).map(key));
  const ids = new Set(assertions.map(a => a.id));
  const depths = new Map(assertions.map(a => [a.id, 1]));
  let improved = false;
  function add(base: Assertion, predicate: string, subject: Assertion['subject'], object: Assertion['subject'], rule: InferenceRule, premises: Assertion[], depth: number): void {
    if (depth > maxDepth || checkRelationEdge(subject.type, predicate, object.type, ontology).length) return;
    const next: Assertion = { id: '', subject: { ...subject }, predicate, object: { ...object }, polarity: 'positive',
      context: structuredClone(base.context), validTime: { ...base.validTime }, status: 'supported',
      evidence: [...new Map(premises.flatMap(p => p.evidence).map(e => [stable(e), structuredClone(e)])).values()],
      origin: 'inferred', ruleId: rule.ruleId, ruleVersion: rule.ruleVersion, revision: 1,
      premiseAssertionIds: premises.map(p => p.id), depth };
    const identity = key(next);
    if (seen.has(identity)) {
      const prior = derived.find(a => key(a) === identity);
      if (prior && depth < (depths.get(prior.id) ?? Infinity)) {
        prior.depth = depth; prior.premiseAssertionIds = next.premiseAssertionIds!;
        prior.ruleId = rule.ruleId; prior.ruleVersion = rule.ruleVersion; prior.evidence = next.evidence;
        depths.set(prior.id, depth);
        improved = true;
      }
      return;
    }
    if (createsSubclassCycle(next, assertions)) return;
    // Escaped full semantic identity is collision-free and stable across input order.
    next.id = `inferred:${encodeURIComponent(stable([rule.ruleId, rule.ruleVersion, identity]))}`;
    if (ids.has(next.id)) throw new Error(`Assertion ID collision: ${next.id}`);
    ids.add(next.id); seen.add(identity); depths.set(next.id, depth); assertions.push(next); derived.push(next);
  }
  for (let round = 0; round < maxRounds; round++) {
    improved = false;
    const before = derived.length;
    const active = assertions.filter(usable);
    for (const rule of validated.rules) {
      if (rule.ruleId === 'R-SUBCLASS-TRANS') {
        for (const a of active) for (const b of active) {
          if (a.predicate !== 'subclass_of' || b.predicate !== 'subclass_of' || !a.object || !b.object || a.object.id !== b.subject.id || scope(a) !== scope(b)) continue;
          add(a, 'subclass_of', a.subject, b.object, rule, [a, b], (depths.get(a.id) ?? 1) + (depths.get(b.id) ?? 1));
        }
      } else if (rule.ruleId === 'R-INVERSE-DECLARED') {
        for (const a of active) {
          const r = ontology.relations.find(r => r.id === a.predicate);
          const inverse = ontology.relations.find(i => i.id === r?.inverseOf);
          if (!a.object || !r || !inverse || inverse.inverseOf !== r.id) continue;
          add(a, inverse.id, a.object, a.subject, rule, [a], (depths.get(a.id) ?? 1) + 1);
        }
      }
    }
    if (before === derived.length && !improved) break;
  }
  return { assertions, derived, invalidateDerived(premiseId: string): Assertion[] {
    const invalid = new Set([premiseId]); const changed: Assertion[] = [];
    const premise = assertions.find(a => a.id === premiseId);
    if (premise) { premise.withdrawn = true; premise.status = 'invalid'; }
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of derived) if (!invalid.has(a.id) && a.premiseAssertionIds?.some(id => invalid.has(id))) {
        a.status = 'invalid'; invalid.add(a.id); changed.push(a); progress = true;
      }
    }
    return changed;
  } };
}
