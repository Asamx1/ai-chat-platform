import { assertionSchema } from './load';
import { defaultOntology } from './registry';
import type { Assertion, Constraints, Ontology, Violation } from './types';
export function checkRelationEdge(subjectType: string, relationId: string, objectType: string, ontology: Ontology = defaultOntology): Violation[] {
  const relation = ontology.relations.find(r => r.id === relationId);
  if (!relation) return [{ code: 'UNKNOWN_RELATION', path: 'predicate', message: `Unknown relation ${relationId}` }];
  const errors: Violation[] = [];
  if (!relation.domain.includes(subjectType)) errors.push({ code: 'DOMAIN', path: 'subject.type', message: `${subjectType} is outside ${relationId} domain` });
  if (!relation.range.includes(objectType)) errors.push({ code: 'RANGE', path: 'object.type', message: `${objectType} is outside ${relationId} range` });
  return errors;
}
export function isActive(a: Assertion): boolean { return !a.withdrawn && a.status !== 'invalid' && a.status !== 'superseded'; }
export function createsSubclassCycle(a: Assertion, existing: readonly Assertion[]): boolean {
  if (a.predicate !== 'subclass_of' || !a.object || a.polarity !== 'positive' || !isActive(a)) return false;
  const stack = [a.object.id]; const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === a.subject.id) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of existing) if (edge.id !== a.id && edge.predicate === 'subclass_of' && edge.polarity === 'positive' && isActive(edge) && edge.subject.id === id && edge.object) stack.push(edge.object.id);
  }
  return false;
}
export function checkAssertion(input: unknown, ontology: Ontology, constraints: Constraints, existing: readonly Assertion[] = []): Violation[] {
  const result = assertionSchema.safeParse(input);
  if (!result.success) return result.error.issues.map(i => ({ code: 'SHAPE', path: i.path.join('.'), message: i.message }));
  const a = result.data as Assertion;
  const errors: Violation[] = [];
  const record = input as Record<string, unknown>;
  for (const field of constraints.requiredFields) if (record[field] === undefined || record[field] === null)
    errors.push({ code: 'REQUIRED', path: field, message: `${field} is required` });
  if (typeof a.value === 'number') for (const field of constraints.numericRequiredFields) if (record[field] === undefined || record[field] === null)
    errors.push({ code: 'NUMERIC_REQUIRED', path: field, message: `${field} is required for numeric results` });
  const relation = ontology.relations.find(r => r.id === a.predicate);
  if (!relation) {
    // Literal predicates are property identifiers, not relation edges.
    if (a.object) errors.push({ code: 'UNKNOWN_RELATION', path: 'predicate', message: `Unknown relation ${a.predicate}` });
    if (!ontology.classes.some(c => c.id === a.subject.type) && !ontology.endpointRoles.includes(a.subject.type))
      errors.push({ code: 'DOMAIN', path: 'subject.type', message: 'Unknown subject type' });
  }
  else {
    if (!relation.domain.includes(a.subject.type)) errors.push({ code: 'DOMAIN', path: 'subject.type', message: 'Subject type outside relation domain' });
    if (!a.object) errors.push({ code: 'OBJECT_REQUIRED', path: 'object', message: 'Declared relations require a typed endpoint; numeric properties require an explicit schema extension' });
    else errors.push(...checkRelationEdge(a.subject.type, a.predicate, a.object.type, ontology).filter(e => e.code !== 'DOMAIN'));
    if (relation.requiresContext && Object.keys(a.context).length === 0) errors.push({ code: 'CONTEXT_REQUIRED', path: 'context', message: 'Relation requires applicability conditions' });
  }
  if (constraints.evidenceTargetsAssertion && ['supports', 'contradicts'].includes(a.predicate) && a.object?.type !== 'Assertion')
    errors.push({ code: 'ASSERTION_TARGET', path: 'object', message: 'Evidence must target a specific assertion ID' });
  if (constraints.forbidSubclassCycles && createsSubclassCycle(a, existing)) errors.push({ code: 'SUBCLASS_CYCLE', path: 'object', message: 'Subclass self-loop or directed cycle' });
  return errors;
}
