import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { inferAssertions, type InferOptions } from './infer.js';
import { canonicalJson } from './jobs.js';
import { sha256 } from './scan.js';
import type { LintIssue } from './lint.js';

// Keep provenance as string[]. Reserved metadata is separate from semantic context.
const context = (value: string | null): Record<string, unknown> => {
  const parsed = JSON.parse(value ?? '{}') as Record<string, unknown>;
  const { _maintenance: _ignored, ...rest } = parsed;
  return rest;
};
const premises = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('INVALID_INFERENCE_PROVENANCE');
  return value as string[];
};
const fingerprint = (ids: string[]) => sha256(canonicalJson([...new Set(ids)].sort()));
function invalidConditions(row: { conditions: string | null; derivedFromJson: unknown }, invalidatedBy: string, reason: string) {
  return canonicalJson({ ...context(row.conditions), _maintenance: {
    premisesSha: fingerprint(premises(row.derivedFromJson)), invalidatedBy, reason,
  } });
}
async function staleAnswers(vaultPath: string, vaultId: string, affected: Set<string>): Promise<string[]> {
  const marked: string[] = [];
  async function walk(path: string): Promise<void> {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`SYMLINK_IN_ANSWERS: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`SYMLINK_IN_ANSWERS: ${file}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !file.endsWith('.md')) continue;
      const text = await readFile(file, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
      if (!front) continue;
      const field = (name: string): unknown => {
        const value = new RegExp(`^${name}: (.+)$`, 'mu').exec(front)?.[1];
        return value === undefined ? undefined : JSON.parse(value);
      };
      if (field('vaultId') !== vaultId) continue;
      const used = field('usedAssertionIds');
      const ids = Array.isArray(used) ? used.filter((id): id is string => typeof id === 'string' && affected.has(id)) : [];
      if (!ids.length) continue;
      const sidecar = `${file}.stale.json`;
      try { if ((await lstat(sidecar)).isSymbolicLink()) throw new Error(`SYMLINK_IN_ANSWERS: ${sidecar}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeFile(sidecar, `${canonicalJson({ stale: true, vaultId, invalidatedBy: ids.sort(), reason: 'premise_retracted' })}\n`);
      marked.push(file);
    }
  }
  await walk(resolve(vaultPath, 'wiki/answers'));
  return marked.sort();
}
export async function propagateRetraction(assertionId: string, db: PrismaClient, opts: { vaultPath?: string } = {}) {
  const result = await db.$transaction(async tx => {
    const source = await tx.vaultAssertion.findUniqueOrThrow({ where: { id: assertionId } });
    if (source.origin !== 'sourced') throw new Error('SOURCED_ASSERTION_REQUIRED');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-infer:${source.vaultId}`}, 0))`;
    await tx.vaultAssertion.update({ where: { id: assertionId }, data: { status: 'retired' } });
    const rows = await tx.vaultInferredAssertion.findMany({ where: { vaultId: source.vaultId } });
    const affected = new Set([assertionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (!affected.has(row.id) && premises(row.derivedFromJson).some(id => affected.has(id))) {
        affected.add(row.id); changed = true;
      }
    }
    let invalidated = 0;
    for (const row of rows) if (affected.has(row.id) && row.status !== 'invalid') {
      await tx.vaultInferredAssertion.update({ where: { id: row.id }, data: {
        status: 'invalid', conditions: invalidConditions(row, assertionId, 'premise_retracted'),
      } });
      invalidated++;
    }
    return { vaultId: source.vaultId, invalidated, affected: [...affected] };
  });
  // Retrying retraction also retries file marking after a filesystem failure.
  const stalePages = await staleAnswers(opts.vaultPath ?? '/mnt/d/wiki-vault', result.vaultId, new Set(result.affected));
  return { ...result, stalePages };
}
export async function recomputeInferences(vaultId: string, db: PrismaClient, opts: InferOptions = {}) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-infer:${vaultId}`}, 0))`;
    const prior = await tx.vaultInferredAssertion.findMany({ where: { vaultId } });
    for (const row of prior) if (row.status !== 'invalid') await tx.vaultInferredAssertion.update({ where: { id: row.id }, data: {
      status: 'invalid', conditions: invalidConditions(row, 'recompute', 'rules_or_premises_changed'),
    } });
    const inferred = await inferAssertions(vaultId, tx, opts);
    const seen = new Set<string>();
    let rebuilt = 0; let unchanged = 0;
    const retained = new Set<string>();
    for (const a of inferred) {
      if (!a.object) throw new Error('INVALID_INFERRED_ASSERTION');
      const identity = { vaultId, subjectId: a.subject.id, predicate: a.predicate, objectId: a.object.id };
      const key = canonicalJson(identity);
      if (seen.has(key)) throw new Error(`AMBIGUOUS_INFERRED_SCOPE: ${key}`);
      seen.add(key);
      const old = prior.find(row => row.subjectId === identity.subjectId && row.predicate === identity.predicate && row.objectId === identity.objectId);
      const data = { ...identity, value: a.value === undefined ? null : JSON.stringify(a.value), polarity: a.polarity === 'positive',
        conditions: canonicalJson({ ...a.context, _maintenance: { premisesSha: fingerprint(a.derivedFrom) } }),
        derivedFromJson: [...new Set(a.derivedFrom)].sort(), ruleVersion: a.ruleVersion, ontologyVersion: a.ontologyVersion,
        revision: `rev-${String(a.revision).padStart(3, '0')}`, status: 'machine' };
      const same = old?.status === 'machine' && fingerprint(premises(old.derivedFromJson)) === fingerprint(a.derivedFrom)
        && canonicalJson(context(old.conditions)) === canonicalJson(a.context) && old.ruleVersion === data.ruleVersion
        && old.ontologyVersion === data.ontologyVersion && old.revision === data.revision && old.value === data.value && old.polarity === data.polarity;
      if (same) unchanged++; else rebuilt++;
      if (old) retained.add(old.id);
      await tx.vaultInferredAssertion.upsert({ where: { vaultId_subjectId_predicate_objectId: identity },
        create: { id: a.id, ...data }, update: same ? { status: old.status, conditions: old.conditions } : data });
    }
    return { invalidated: prior.filter(row => row.status !== 'invalid' && !retained.has(row.id)).length, rebuilt, unchanged };
  });
}
export async function markVersionStaleness(vaultId: string, db: PrismaClient): Promise<(LintIssue & { severity: 'warn'; oldEntityId: string; newEntityId: string })[]> {
  const rows = await db.vaultAssertion.findMany({ where: { vaultId, origin: 'sourced', status: { in: ['supported', 'candidate'] } },
    include: { evidence: { where: { vaultId, source: { vaultId } }, include: { source: true } } }, orderBy: { id: 'asc' } });
  return rows.filter(row => row.predicate === 'supersedes' && row.polarity && row.status === 'supported' && row.objectId).flatMap(edge =>
    rows.filter(row => row.subjectId === edge.objectId).flatMap(row => {
      const sources = [...new Set(row.evidence.filter(e => e.source.createdAt > edge.createdAt).map(e => e.sourceId))];
      return sources.length ? [{ category: 'timeliness' as const, code: 'OLD_ENTITY_NEW_EVIDENCE', severity: 'warn' as const,
        oldEntityId: edge.objectId!, newEntityId: edge.subjectId, assertionIds: [edge.id, row.id], sourceIds: sources,
        message: '旧实体收到新信息，疑似应挂在新版本上；适用范围待核实。' }] : [];
    }));
}
export async function demoteLonelyConcepts(vaultId: string, db: PrismaClient) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wiki-publish:${vaultId}`}, 0))`;
    const entities = await tx.vaultEntityCandidate.findMany({ where: { vaultId, status: 'promoted', type: { not: 'Source' } }, orderBy: { id: 'asc' } });
    const demoted: string[] = []; const pagesToRemove: string[] = [];
    for (const entity of entities) {
      const evidence = await tx.vaultEvidence.findMany({ where: { vaultId, stance: 'supports', source: { vaultId },
        assertion: { vaultId, origin: 'sourced', status: 'supported', OR: [{ subjectId: entity.id }, { objectId: entity.id }] } }, include: { source: true } });
      const families = [...new Set(evidence.map(e => e.source.familyId))].sort();
      if (families.length >= 2) continue;
      await tx.vaultEntityCandidate.update({ where: { id: entity.id }, data: { status: 'candidate', familyIdsJson: families, promotedPageId: null } });
      demoted.push(entity.id);
      if (entity.promotedPageId) pagesToRemove.push(`wiki/concepts/${entity.promotedPageId}.md`);
    }
    return { demoted, pagesToRemove };
  });
}
