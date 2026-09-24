import { readFileSync } from 'node:fs';
import { loadOntology } from './load.js';
import type { Ontology } from './types.js';
export const defaultOntology = loadOntology(readFileSync(new URL('../defaults/ontology.yaml', import.meta.url), 'utf8'));
export function createRegistry(ontology: Ontology = defaultOntology) {
  const classes = new Map(ontology.classes.map(c => [c.id, c]));
  const relations = new Map(ontology.relations.map(r => [r.id, r]));
  return {
    getClass: (id: string) => classes.get(id),
    getRelation: (id: string) => relations.get(id),
    relationsFor: (subjectType: string, objectType: string) => ontology.relations.filter(r => r.domain.includes(subjectType) && r.range.includes(objectType)),
  };
}
