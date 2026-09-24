import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { lintStructure, lintProvenance, lintConflicts, lintTimeliness, lintVault } from '../src/lint.js';
import { registerSource, sha256 } from '../src/scan.js';
const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('lint with real PostgreSQL', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_lint_${randomUUID().replaceAll('-', '')}`;
  const roots: string[] = [];
  beforeAll(async () => {
    const [{ Pool }, { PrismaPg }, { PrismaClient: Client }] = await Promise.all([
      import('pg'), import('@prisma/adapter-pg'), import('../../db/src/generated/client.js'),
    ]);
    pool = new Pool({ connectionString: testUrl! });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`CREATE SCHEMA "${schema}"`);
      await connection.query(`SET LOCAL search_path TO "${schema}"`);
      for (const migration of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type', '20260927000000_wiki_jobs']) {
        await connection.query(await readFile(new URL(`../../db/prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
      }
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
    db = new Client({ adapter: new PrismaPg({ connectionString: testUrl! }, { schema }) });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const vaultId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'wiki-lint-')); roots.push(root);
    await mkdir(join(root, 'wiki/concepts'), { recursive: true });
    await writeFile(join(root, 'wiki/index.md'), '[[concepts/alpha]]');
    await writeFile(join(root, 'wiki/concepts/alpha.md'), '# Alpha');
    const sources = [];
    for (const title of ['First', 'Second']) sources.push((await registerSource({ title, filePath: `raw/articles/${title}.txt`, sha256: sha256(title), bytes: 5n, mimeType: 'text/plain' }, vaultId, db)).source);
    const first = sources[0]!; const second = sources[1]!;
    const entity = await db.vaultEntityCandidate.create({ data: { vaultId, canonicalName: 'Alpha', type: 'Model', status: 'promoted', promotedPageId: 'alpha', firstSourceId: first.id, familyIdsJson: [first.familyId], aliasesJson: [] } });
    await db.vaultPage.create({ data: { vaultId, pageId: 'alpha', kind: 'concept', title: 'Alpha', revision: 'rev-001', filePath: 'wiki/concepts/alpha.md', ontologyVersion: '1.0.0' } });
    const assertion = await db.vaultAssertion.create({ data: { id: `asr_${randomUUID()}`, vaultId, subjectId: entity.id, predicate: 'score', value: '10', polarity: true, conditions: '{"dataset":"test"}', status: 'supported', origin: 'sourced', revision: 'rev-001', ontologyVersion: '1.0.0' } });
    await db.vaultEvidence.create({ data: { vaultId, assertionId: assertion.id, sourceId: first.id, sourceSha256: first.sha256, locatorKind: 'page', locatorJson: '{"page":1}', quote: 'Alpha score 10', stance: 'supports' } });
    return { vaultId, root, first, second, entity, assertion };
  }
  it('reports broken links, missing index entries and system orphans; accepts valid navigation and manual pages', async () => {
    const f = await fixture();
    expect(await lintStructure(f.root, f.vaultId, db)).toEqual([]);
    await db.vaultEntityCandidate.create({ data: { vaultId: f.vaultId, canonicalName: 'Beta', type: 'Task', status: 'candidate', firstSourceId: f.first.id, familyIdsJson: [], aliasesJson: [] } });
    await writeFile(join(f.root, 'wiki/concepts/alpha.md'), '[[../index.md#top|Index]] [[concepts/beta]] [[missing]]');
    await writeFile(join(f.root, 'wiki/concepts/manual.md'), '# Manual');
    await db.vaultEntityCandidate.delete({ where: { id: f.entity.id } });
    const issues = await lintStructure(f.root, f.vaultId, db);
    expect(issues.map(i => i.code).sort()).toEqual(['BROKEN_LINK', 'INDEX_OMISSION', 'ORPHAN_CONCEPT']);
    expect(issues.find(i => i.code === 'BROKEN_LINK')!.message).toContain('missing');
    expect(issues.find(i => i.code === 'ORPHAN_CONCEPT')!.path).toBe('wiki/concepts/alpha.md');
  });
  it('accepts source evidence, reports missing evidence and answer pages used as evidence', async () => {
    const f = await fixture();
    expect(await lintProvenance(f.vaultId, db)).toEqual([]);
    await db.vaultSource.update({ where: { id: f.first.id }, data: { filePath: 'answers/result.md' } });
    expect(await lintProvenance(f.vaultId, db)).toMatchObject([{ code: 'ANSWER_AS_EVIDENCE', sourceIds: [f.first.id] }]);
    await db.vaultEvidence.deleteMany({ where: { assertionId: f.assertion.id } });
    expect(await lintProvenance(f.vaultId, db)).toMatchObject([{ code: 'MISSING_EVIDENCE', assertionIds: [f.assertion.id] }]);
  });
  it('compares values only within matching subject, predicate, polarity and canonical conditions, identifying both sources', async () => {
    const f = await fixture();
    expect(await lintConflicts(f.vaultId, db)).toEqual([]);
    const other = await db.vaultAssertion.create({ data: { ...f.assertion, id: `asr_${randomUUID()}`, conditions: '{ "dataset": "test" }' } });
    await db.vaultEvidence.create({ data: { vaultId: f.vaultId, assertionId: other.id, sourceId: f.second.id, sourceSha256: f.second.sha256, locatorKind: 'page', locatorJson: '{"page":2}', quote: 'score', stance: 'supports' } });
    expect(await lintConflicts(f.vaultId, db)).toEqual([]);
    await db.vaultAssertion.update({ where: { id: other.id }, data: { value: '20' } });
    const issues = await lintConflicts(f.vaultId, db);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.sourceIds).toEqual(expect.arrayContaining([f.first.id, f.second.id]));
    for (const data of [{ polarity: false }, { polarity: true, conditions: '{"dataset":"different"}' }, { conditions: f.assertion.conditions, predicate: 'other' }, { predicate: f.assertion.predicate, subjectId: 'other' }]) {
      await db.vaultAssertion.update({ where: { id: other.id }, data });
      expect(await lintConflicts(f.vaultId, db)).toEqual([]);
    }
  });
  it('uses optional supersededAt metadata and compares source creation strictly after the cutoff', async () => {
    const f = await fixture();
    expect(await lintTimeliness(f.vaultId, db)).toEqual([]);
    for (const cutoff of [new Date(f.first.createdAt.getTime() + 1000).toISOString(), f.first.createdAt.toISOString(), 'invalid']) {
      await db.vaultAssertion.update({ where: { id: f.assertion.id }, data: { conditions: JSON.stringify({ supersededAt: cutoff }) } });
      expect(await lintTimeliness(f.vaultId, db)).toEqual([]);
    }
    await db.vaultAssertion.update({ where: { id: f.assertion.id }, data: { conditions: JSON.stringify({ supersededAt: new Date(f.first.createdAt.getTime() - 1000).toISOString() }) } });
    expect(await lintTimeliness(f.vaultId, db)).toMatchObject([{ code: 'STALE_INFORMATION', assertionIds: [f.assertion.id], sourceIds: [f.first.id] }]);
    expect((await lintVault(f.root, randomUUID(), db)).issues).toEqual([]);
    expect((await lintVault(f.root, f.vaultId, db)).issues.map(i => i.category)).toEqual(['timeliness']);
  });
});
