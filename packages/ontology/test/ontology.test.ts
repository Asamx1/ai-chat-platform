import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadOntology, loadConstraints, loadInferenceRules, defaultOntology, createRegistry,
  checkAssertion, checkRelationEdge, runInference, transitionStatus } from '../src/index.js';
import type { Assertion } from '../src/types.js';
const read = (name: string) => readFileSync(new URL(`../defaults/${name}.yaml`, import.meta.url), 'utf8');
const ontology = loadOntology(read('ontology'));
const constraints = loadConstraints(read('constraints'));
const rules = loadInferenceRules(read('inference-rules'));
function edge(subject: string, object: string, overrides: Partial<Assertion> = {}): Assertion {
  return { id: `${subject}-${object}`, subject: { id: subject, type: 'Class' }, predicate: 'subclass_of',
    object: { id: object, type: 'Class' }, polarity: 'positive', context: {}, validTime: { from: null, to: null },
    status: 'supported', evidence: [{ sourceId: 's1', sourceVersion: 'hash1', locator: 'section 1', excerpt: 'type hierarchy', relation: 'supports' }],
    origin: 'sourced', ruleVersion: '1.0.0', revision: 1, ...overrides };
}
describe('ontology YAML and contracts', () => {
  it('rejects malformed YAML, duplicate keys, invalid schema, versions and unknown rules with details', () => {
    expect(() => loadOntology('classes: [')).toThrow(/ontology:/);
    expect(() => loadOntology('version: 1\nversion: 2')).toThrow(/ontology:/);
    expect(() => loadOntology('version: nope')).toThrow(/version/);
    expect(() => loadConstraints('version: "1.0.0"')).toThrow(/requiredFields/);
    expect(() => loadInferenceRules(read('inference-rules').replace('R-SUBCLASS-TRANS', 'related implies causes'))).toThrow(/ruleId/);
    expect(() => loadOntology(read('ontology').replace('range: ["Class"]', 'range: ["Missing"]'))).toThrow(/endpoint/);
  });
  it('contains seven classes and all nine relation groups (ten distinct IDs)', () => {
    expect(ontology.classes).toHaveLength(7);
    expect(ontology.relations.map(r => r.id)).toEqual(['instance_of', 'subclass_of', 'broader_than', 'uses', 'supports_task', 'evaluated_on', 'supports', 'contradicts', 'supersedes', 'related_to']);
    for (const r of ontology.relations) {
      expect(r.label.length).toBeGreaterThan(0); expect(r.description.length).toBeGreaterThan(0);
      expect(r.domain.length).toBeGreaterThan(0); expect(r.range.length).toBeGreaterThan(0);
      for (const flag of [r.symmetric, r.transitive, r.requiresContext]) expect(typeof flag).toBe('boolean');
    }
    expect(ontology.aliases.similarityMayMerge).toBe(false);
    expect(defaultOntology).toEqual(ontology);
    expect(createRegistry(ontology).getClass('Model')?.abstract).toBe(false);
    expect(createRegistry(ontology).relationsFor('Model', 'Task').map(r => r.id)).toContain('supports_task');
  });
  it('rejects endpoint mismatches, absent context, document evidence targets and malformed assertions', () => {
    expect(checkRelationEdge('Dataset', 'uses', 'Task').map(v => v.code)).toEqual(['DOMAIN', 'RANGE']);
    expect(checkRelationEdge('Model', 'uses', 'Method')).toEqual([]);
    expect(checkRelationEdge('Model', 'unknown', 'Method')[0]?.code).toBe('UNKNOWN_RELATION');
    expect(checkAssertion(edge('m', 't', { subject: { id: 'm', type: 'Model' }, object: { id: 't', type: 'Task' }, predicate: 'supports_task' }), ontology, constraints).map(v => v.code)).toContain('CONTEXT_REQUIRED');
    expect(checkAssertion(edge('e', 'doc', { subject: { id: 'e', type: 'Evidence' }, object: { id: 'doc', type: 'Source' }, predicate: 'supports' }), ontology, constraints).map(v => v.code)).toContain('ASSERTION_TARGET');
    expect(checkAssertion({}, ontology, constraints).length).toBeGreaterThan(0);
    const { object: _object, ...base } = edge('m', 'd');
    const numeric = { ...base, predicate: 'accuracy', value: 0.9, unit: 'ratio', dataset: 'd', testSettings: {}, metric: 'accuracy' };
    expect(checkAssertion(numeric, ontology, constraints)).toEqual([]);
    expect(checkAssertion({ ...numeric, metric: undefined }, ontology, constraints).map(v => v.code)).toContain('NUMERIC_REQUIRED');
  });
  it('rejects self loops and cycles across existing assertions', () => {
    expect(checkAssertion(edge('a', 'a'), ontology, constraints).map(v => v.code)).toContain('SUBCLASS_CYCLE');
    expect(checkAssertion(edge('c', 'a'), ontology, constraints, [edge('a', 'b'), edge('b', 'c')]).map(v => v.code)).toContain('SUBCLASS_CYCLE');
    expect(() => runInference([edge('a', 'b'), edge('b', 'a')], rules)).toThrow(/cycle/);
  });
  it('rejects illegal status transitions', () => {
    expect(transitionStatus('candidate', 'supported')).toBe('supported');
    expect(() => transitionStatus('invalid', 'supported')).toThrow(/Illegal/);
    expect(() => transitionStatus('supported', 'candidate')).toThrow(/Illegal/);
  });
});
describe('finite inference and provenance', () => {
  const chain = Array.from({ length: 6 }, (_, i) => edge(String(i), String(i + 1)));
  it('bounds path depth and rounds and deduplicates closure', () => {
    const { derived } = runInference(chain, rules);
    expect(derived.some(a => a.subject.id === '0' && a.object?.id === '5')).toBe(true);
    expect(derived.some(a => a.subject.id === '0' && a.object?.id === '6')).toBe(false);
    expect(derived.every(a => a.origin === 'inferred' && a.ruleVersion === '1.0.0' && a.premiseAssertionIds?.length === 2)).toBe(true);
    expect(new Set(derived.map(a => `${a.subject.id}-${a.object?.id}`)).size).toBe(derived.length);
    expect(runInference(chain, rules, { maxDepth: 1 }).derived).toEqual([]);
    expect(runInference(chain, rules, { maxRounds: 1 }).derived.every(a => a.depth === 2)).toBe(true);
    expect(() => runInference(chain, rules, { maxRounds: 0 })).toThrow(/maxRounds/);
  });
  it('propagates withdrawal to downstream conclusions and recomputes without revoked premises', () => {
    const result = runInference(chain, rules);
    const descendants = result.invalidateDerived('0-1');
    expect(descendants.length).toBeGreaterThan(1);
    expect(descendants.every(a => a.status === 'invalid')).toBe(true);
    expect(result.derived.filter(a => a.subject.id === '0').every(a => a.status === 'invalid')).toBe(true);
    expect(result.derived.some(a => a.subject.id === '1' && a.status === 'supported')).toBe(true);
    expect(runInference(result.assertions, rules).derived.some(a => a.subject.id === '0')).toBe(false);
    expect(runInference([edge('a', 'b', { withdrawn: true }), edge('b', 'c')], rules).derived).toEqual([]);
  });
  it('does not infer from negative, contested or differently scoped premises', () => {
    for (const patch of [{ polarity: 'negative' as const }, { status: 'contested' as const }, { context: { version: 2 } }, { validTime: { from: '2026-01-01', to: null } }])
      expect(runInference([edge('a', 'b', patch), edge('b', 'c')], rules).derived).toEqual([]);
  });
  it('never treats navigation or uses as transitive and ignores prose as code', () => {
    for (const predicate of ['broader_than', 'related_to', 'uses']) {
      const type = predicate === 'uses' ? 'Method' : 'Concept';
      const inputs = [edge('a', 'b'), edge('b', 'c')].map(a => ({ ...a, predicate, subject: { ...a.subject, type }, object: { id: a.object!.id, type }, context: { mode: 'test' } }));
      expect(runInference(inputs, rules).derived).toEqual([]);
    }
    expect(() => runInference(chain, { ...rules, rules: [{ ...rules.rules[0]!, approved: false } as never] })).toThrow();
    expect(() => runInference(chain, { ...rules, rules: [{ ...rules.rules[0]!, ruleId: 'natural-language' } as never] })).toThrow();
  });
  it('requires reciprocal inverse declarations; default rule is empty', () => {
    const a = edge('a', 'b', { predicate: 'related_to', subject: { id: 'a', type: 'Concept' }, object: { id: 'b', type: 'Concept' } });
    expect(runInference([a], rules).derived).toEqual([]);
    const custom = structuredClone(ontology);
    const relation = custom.relations.find(r => r.id === 'related_to')!;
    relation.inverseOf = 'related_from';
    custom.relations.push({ ...relation, id: 'related_from', inverseOf: 'related_to' });
    const result = runInference([a], rules, { ontology: custom });
    expect(result.derived).toHaveLength(1);
    expect(result.derived[0]).toMatchObject({ predicate: 'related_from', subject: { id: 'b' }, object: { id: 'a' }, ruleId: 'R-INVERSE-DECLARED', premiseAssertionIds: ['a-b'] });
  });
});
