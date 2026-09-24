import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@aichat/db';
import { defaultOntology, loadInferenceRules, type Assertion } from '@aichat/ontology';
import { deriveAssertions, inferAssertions, persistInferred } from '../src/infer.js';

const rules = loadInferenceRules(readFileSync(new URL('../../ontology/defaults/inference-rules.yaml', import.meta.url), 'utf8'));
function edge(a: string, b: string, predicate = 'subclass_of'): Assertion {
  const type = predicate === 'subclass_of' ? 'Class' : 'Model';
  return { id: `${a}-${b}`, subject: { id: a, type }, object: { id: b, type }, predicate,
    polarity: 'positive', context: predicate === 'supersedes' ? { scope: 'api' } : {}, validTime: { from: null, to: null },
    status: 'supported', evidence: [], origin: 'sourced', ruleVersion: '1.0.0', revision: 2 };
}
describe('bounded vault inference', () => {
  it('loads the vault and expands a three-edge subclass chain to sourced roots', async () => {
    const input = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const tx = {
      vaultAssertion: { findMany: vi.fn(async () => input.map(a => ({ id: a.id, subjectId: a.subject.id, objectId: a.object!.id,
        predicate: a.predicate, polarity: true, conditions: '{}', validFrom: null, validTo: null, status: a.status,
        origin: a.origin, ontologyVersion: '1.0.0', ruleVersion: null, revision: 'rev-002' }))) },
      vaultEntityCandidate: { findMany: async () => ['A', 'B', 'C', 'D'].map(id => ({ id, type: 'Class' })) },
    };
    const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
    const result = await inferAssertions('vault', db, { rules });
    expect(tx.vaultAssertion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ vaultId: 'vault', status: { in: ['supported', 'candidate'] } }) }));
    expect(result).toHaveLength(3);
    expect(result.find(a => a.subject.id === 'A' && a.object?.id === 'D')).toMatchObject({ origin: 'inferred',
      derivedFrom: ['A-B', 'B-C', 'C-D'], ruleVersion: '1.0.0', revision: 2 });
    expect(deriveAssertions('vault', input, defaultOntology, rules, { maxDepth: 2 }).some(a => a.subject.id === 'A' && a.object?.id === 'D')).toBe(false);
  });
  it('skips cyclic chains with warnings while preserving unrelated conclusions', () => {
    const warnings: string[] = [];
    const result = deriveAssertions('v', [edge('A', 'B'), edge('B', 'A'), edge('C', 'D'), edge('D', 'E')], defaultOntology, rules, { warnings });
    expect(warnings).toEqual(['CYCLE_SKIPPED: A-B', 'CYCLE_SKIPPED: B-A']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subject: { id: 'C' }, object: { id: 'E' } });
  });
  it('propagates supersedes only within matching context and time; candidates are not promoted', () => {
    const a = edge('new', 'middle', 'supersedes'); const b = edge('middle', 'old', 'supersedes');
    expect(deriveAssertions('v', [a, b], defaultOntology, rules)[0]).toMatchObject({ predicate: 'supersedes', derivedFrom: ['new-middle', 'middle-old'] });
    expect(deriveAssertions('v', [a, { ...b, context: { scope: 'other' } }], defaultOntology, rules)).toEqual([]);
    expect(deriveAssertions('v', [a, { ...b, status: 'candidate' }], defaultOntology, rules)).toEqual([]);
    expect(deriveAssertions('v', [a, { ...b, validTime: { from: '2026-01-01', to: null } }], defaultOntology, rules)).toEqual([]);
  });
  it('upserts into the separate machine table and reports created/updated counts', async () => {
    const inferred = deriveAssertions('v', [edge('A', 'B'), edge('B', 'C')], defaultOntology, rules);
    let exists = false;
    const upsert = vi.fn(async () => { exists = true; });
    const tx = { $executeRaw: async () => 1, vaultInferredAssertion: { findUnique: async () => exists ? { id: inferred[0]!.id } : null, upsert } };
    const db = { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient;
    expect(await persistInferred('v', db, inferred)).toEqual({ created: 1, updated: 0 });
    expect(await persistInferred('v', db, inferred)).toEqual({ created: 0, updated: 1 });
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: 'machine', derivedFromJson: ['A-B', 'B-C'] }) }));
  });
});
