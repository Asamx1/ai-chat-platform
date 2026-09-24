import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Prisma, PrismaClient, VaultAssertion } from '@aichat/db';
import { z } from 'zod';
import { defaultOntology, loadOntology, loadInferenceRules, runInference,
  type Assertion, type Ontology, type InferenceRules } from '@aichat/ontology';
import { sha256 } from './scan.js';

export interface InferredAssertion extends Assertion {
  origin: 'inferred'; derivedFrom: string[]; ontologyVersion: string;
}
export interface InferOptions {
  vaultPath?: string; ontology?: Ontology; rules?: InferenceRules;
  maxDepth?: number; maxRounds?: number; warnings?: string[];
}
const revision = (value: string): number => /^rev-\d+$/u.test(value) ? Number(value.slice(4)) : 0;
export function toOntologyAssertion(row: VaultAssertion, entities: ReadonlyMap<string, { type: string }>): Assertion | undefined {
  const subject = entities.get(row.subjectId);
  const object = row.objectId ? entities.get(row.objectId) : undefined;
  if (!subject || (row.objectId && !object)) return undefined;
  return { id: row.id, subject: { id: row.subjectId, type: subject.type }, predicate: row.predicate,
    ...(row.objectId && object ? { object: { id: row.objectId, type: object.type } }
      : { value: z.union([z.string(), z.number(), z.boolean()]).parse(JSON.parse(row.value ?? 'null')) }),
    polarity: row.polarity ? 'positive' : 'negative', context: z.record(z.string(), z.unknown()).parse(JSON.parse(row.conditions ?? '{}')),
    validTime: { from: row.validFrom, to: row.validTo }, status: row.status as Assertion['status'], origin: 'sourced',
    ruleVersion: row.ruleVersion ?? row.ontologyVersion, revision: Math.max(1, revision(row.revision)), evidence: [] };
}

// Remove every edge participating in a cycle, preserving independent acyclic chains.
// Candidate rows remain candidates: the ontology evaluator only derives from supported premises.
export function deriveAssertions(vaultId: string, input: readonly Assertion[], ontology: Ontology,
  rules: InferenceRules, opts: Pick<InferOptions, 'warnings' | 'maxDepth' | 'maxRounds'> = {}): InferredAssertion[] {
  const edges = input.filter(a => a.origin === 'sourced' && !a.withdrawn && ['supported', 'candidate'].includes(a.status)
    && a.polarity === 'positive' && a.object && ['subclass_of', 'supersedes'].includes(a.predicate));
  const cyclic = new Set<string>();
  for (const edge of edges) {
    const stack = [edge.object!.id]; const visited = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === edge.subject.id) { cyclic.add(edge.id); break; }
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push(...edges.filter(a => a.id !== edge.id && a.predicate === edge.predicate && a.subject.id === id).map(a => a.object!.id));
    }
  }
  for (const id of cyclic) opts.warnings?.push(`CYCLE_SKIPPED: ${id}`);
  const safe = input.filter(a => !cyclic.has(a.id));
  const result = runInference(safe, { ...rules, rules: rules.rules.filter(r => ['R-SUBCLASS-TRANS', 'R-SUPERSEDES-TRANS'].includes(r.ruleId)) }, {
    ontology, maxRounds: opts.maxRounds ?? 100, ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  });
  const byId = new Map(result.assertions.map(a => [a.id, a]));
  const roots = (id: string, visited = new Set<string>()): string[] => {
    if (visited.has(id)) throw new Error(`INFERENCE_PROVENANCE_CYCLE: ${id}`);
    const a = byId.get(id);
    if (!a) throw new Error(`MISSING_INFERENCE_PREMISE: ${id}`);
    if (a.origin === 'sourced') return [id];
    return (a.premiseAssertionIds ?? []).flatMap(parent => roots(parent, new Set([...visited, id])));
  };
  return result.derived.map(a => {
    const derivedFrom = [...new Set(roots(a.id))];
    return { ...a, id: `inf_${sha256(JSON.stringify([vaultId, a.id])).slice(0, 32)}`, origin: 'inferred',
      derivedFrom, premiseAssertionIds: derivedFrom, ontologyVersion: ontology.version,
      revision: Math.max(...derivedFrom.map(id => byId.get(id)!.revision)) };
  });
}

export async function inferAssertions(vaultId: string, db: PrismaClient | Prisma.TransactionClient, opts: InferOptions = {}): Promise<InferredAssertion[]> {
  const ontology = opts.ontology ?? (opts.vaultPath
    ? loadOntology(await readFile(resolve(opts.vaultPath, 'schema/ontology.yaml'), 'utf8')) : defaultOntology);
  const rules = opts.rules ?? loadInferenceRules(await readFile(opts.vaultPath
    ? resolve(opts.vaultPath, 'schema/inference-rules.yaml') : new URL('../../ontology/defaults/inference-rules.yaml', import.meta.url), 'utf8'));
  const run = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.vaultAssertion.findMany({ where: { vaultId, origin: 'sourced', status: { in: ['supported', 'candidate'] },
      ontologyVersion: ontology.version }, orderBy: { id: 'asc' } });
    const entities = await tx.vaultEntityCandidate.findMany({ where: { vaultId }, orderBy: { id: 'asc' } });
    const byId = new Map(entities.map(e => [e.id, e]));
    const assertions = rows.flatMap(row => { const a = toOntologyAssertion(row, byId); return a ? [a] : []; });
    return deriveAssertions(vaultId, assertions, ontology, rules, opts);
  };
  return '$transaction' in db ? db.$transaction(run, { isolationLevel: 'RepeatableRead' }) : run(db);
}

export async function persistInferred(vaultId: string, db: PrismaClient, inferred: readonly InferredAssertion[]): Promise<{ created: number; updated: number }> {
  // The mandated unique key cannot represent two contexts for the same edge. Fail
  // explicitly instead of silently replacing one scoped conclusion with another.
  const keys = new Set<string>();
  for (const a of inferred) {
    if (!a.object || a.origin !== 'inferred' || !a.derivedFrom.length) throw new Error('INVALID_INFERRED_ASSERTION');
    const key = JSON.stringify([a.subject.id, a.predicate, a.object.id]);
    if (keys.has(key)) throw new Error(`AMBIGUOUS_INFERRED_SCOPE: ${key}`);
    keys.add(key);
  }
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-infer:${vaultId}`}, 0))`;
    let created = 0; let updated = 0;
    for (const a of inferred) {
      const identity = { vaultId, subjectId: a.subject.id, predicate: a.predicate, objectId: a.object!.id };
      const where = { vaultId_subjectId_predicate_objectId: identity };
      const prior = await tx.vaultInferredAssertion.findUnique({ where });
      const data = { ...identity, value: a.value === undefined ? null : JSON.stringify(a.value), polarity: a.polarity === 'positive',
        conditions: JSON.stringify(a.context), derivedFromJson: a.derivedFrom, ruleVersion: a.ruleVersion,
        ontologyVersion: a.ontologyVersion, revision: `rev-${String(a.revision).padStart(3, '0')}`, status: 'machine' };
      await tx.vaultInferredAssertion.upsert({ where, create: { id: a.id, ...data }, update: { id: a.id, ...data } });
      if (prior) updated++; else created++;
    }
    return { created, updated };
  });
}
