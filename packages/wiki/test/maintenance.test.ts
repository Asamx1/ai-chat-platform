import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { loadInferenceRules } from '@aichat/ontology';
import { registerSource, sha256 } from '../src/scan.js';
import { promoteEntity } from '../src/promote.js';
import { propagateRetraction, recomputeInferences, markVersionStaleness, demoteLonelyConcepts } from '../src/maintenance.js';

const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('maintenance with real PostgreSQL', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_maintenance_${randomUUID().replaceAll('-', '')}`;
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
      for (const migration of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type', '20260926000000_vault_inferred']) {
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
  async function fixture(predicate = 'subclass_of') {
    const vaultId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'wiki-maintenance-'));
    roots.push(root);
    const sources = [];
    for (const title of ['First', 'Second']) sources.push((await registerSource({ title, filePath: `raw/articles/${title}.txt`, sha256: sha256(title), bytes: 5n, mimeType: 'text/plain' }, vaultId, db)).source);
    const entities = [];
    for (const canonicalName of ['A', 'B', 'C', 'D']) entities.push(await db.vaultEntityCandidate.create({ data: {
      vaultId, canonicalName, type: predicate === 'supersedes' ? 'Model' : 'Class', status: 'candidate',
      firstSourceId: sources[0]!.id, familyIdsJson: sources.map(s => s.familyId), aliasesJson: [],
    } }));
    const assertions = [];
    for (let i = 0; i < 3; i++) assertions.push(await db.vaultAssertion.create({ data: {
      id: `asr_${randomUUID()}`, vaultId, subjectId: entities[i]!.id, objectId: entities[i + 1]!.id,
      predicate, polarity: true, conditions: '{}', status: 'supported', origin: 'sourced', revision: 'rev-001', ontologyVersion: '1.0.0',
    } }));
    async function evidence(assertionId: string, sourceIndex: number) {
      const source = sources[sourceIndex]!;
      return db.vaultEvidence.create({ data: { vaultId, assertionId, sourceId: source.id, sourceSha256: source.sha256,
        locatorKind: 'page', locatorJson: '{"page":1}', quote: 'Fixture support.', stance: 'supports' } });
    }
    return { vaultId, root, sources, entities, assertions, evidence };
  }
  it('cascades nested dependencies, marks archived answers, and never revives a withdrawn premise', async () => {
    const f = await fixture();
    expect((await recomputeInferences(f.vaultId, db)).rebuilt).toBe(3);
    const first = await db.vaultInferredAssertion.findFirstOrThrow({ where: { vaultId: f.vaultId, subjectId: f.entities[0]!.id, objectId: f.entities[2]!.id } });
    const nested = await db.vaultInferredAssertion.create({ data: { id: `inf_${randomUUID()}`, vaultId: f.vaultId,
      subjectId: f.entities[3]!.id, objectId: f.entities[0]!.id, predicate: 'subclass_of', polarity: true,
      conditions: '{"scope":"fixture"}', derivedFromJson: [first.id], ruleVersion: '1.0.0', ontologyVersion: '1.0.0', revision: 'rev-001' } });
    await mkdir(join(f.root, 'wiki/answers'), { recursive: true });
    const answer = join(f.root, 'wiki/answers/example.md');
    const original = `---\nvaultId: ${JSON.stringify(f.vaultId)}\nusedAssertionIds: ${JSON.stringify([nested.id])}\n---\nHistorical answer\n`;
    await writeFile(answer, original);
    const result = await propagateRetraction(f.assertions[0]!.id, db, { vaultPath: f.root });
    expect(result.invalidated).toBe(3);
    expect(result.stalePages).toEqual([answer]);
    expect(JSON.parse(await readFile(`${answer}.stale.json`, 'utf8'))).toMatchObject({ stale: true, invalidatedBy: [nested.id] });
    expect(await readFile(answer, 'utf8')).toBe(original);
    const invalid = await db.vaultInferredAssertion.findUniqueOrThrow({ where: { id: nested.id } });
    expect(invalid.status).toBe('invalid');
    expect(JSON.parse(invalid.conditions!)).toMatchObject({ scope: 'fixture', _maintenance: { invalidatedBy: f.assertions[0]!.id, reason: 'premise_retracted' } });
    expect((await propagateRetraction(f.assertions[0]!.id, db, { vaultPath: f.root })).invalidated).toBe(0);
    await recomputeInferences(f.vaultId, db);
    expect((await db.vaultInferredAssertion.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('invalid');
    expect(await db.vaultInferredAssertion.count({ where: { vaultId: f.vaultId, status: 'machine' } })).toBe(1);
    await db.vaultAssertion.update({ where: { id: f.assertions[0]!.id }, data: { status: 'supported' } });
    expect((await recomputeInferences(f.vaultId, db)).rebuilt).toBe(2);
    expect((await db.vaultInferredAssertion.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('machine');
  });
  it('is idempotent and rebuilds when the rule version changes', async () => {
    const f = await fixture();
    expect(await recomputeInferences(f.vaultId, db)).toEqual({ invalidated: 0, rebuilt: 3, unchanged: 0 });
    const before = await db.vaultInferredAssertion.findMany({ where: { vaultId: f.vaultId }, orderBy: { id: 'asc' } });
    expect(await recomputeInferences(f.vaultId, db)).toEqual({ invalidated: 0, rebuilt: 0, unchanged: 3 });
    expect(await db.vaultInferredAssertion.findMany({ where: { vaultId: f.vaultId }, orderBy: { id: 'asc' } })).toEqual(before);
    const rules = loadInferenceRules(await readFile(new URL('../../ontology/defaults/inference-rules.yaml', import.meta.url), 'utf8'));
    const updated = { ...rules, version: '1.0.1', rules: rules.rules.map(rule => ({ ...rule, ruleVersion: '1.0.1' })) };
    expect((await recomputeInferences(f.vaultId, db, { rules: updated })).rebuilt).toBe(3);
    expect(await recomputeInferences(f.vaultId, db, { rules: { ...rules, rules: [] } })).toEqual({ invalidated: 3, rebuilt: 0, unchanged: 0 });
    expect((await recomputeInferences(f.vaultId, db, { rules: { ...rules, rules: [] } })).invalidated).toBe(0);
  });
  it('warns once for late evidence on an old entity without modifying assertions', async () => {
    const f = await fixture('supersedes');
    await db.vaultAssertion.updateMany({ where: { vaultId: f.vaultId }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    await db.vaultSource.updateMany({ where: { vaultId: f.vaultId }, data: { createdAt: new Date('2026-01-02T00:00:00Z') } });
    await f.evidence(f.assertions[1]!.id, 0);
    const before = await db.vaultAssertion.findMany({ where: { vaultId: f.vaultId }, orderBy: { id: 'asc' } });
    const warnings = await markVersionStaleness(f.vaultId, db);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: 'warn', category: 'timeliness', oldEntityId: f.entities[1]!.id, newEntityId: f.entities[0]!.id });
    expect(await db.vaultAssertion.findMany({ where: { vaultId: f.vaultId }, orderBy: { id: 'asc' } })).toEqual(before);
    await db.vaultSource.updateMany({ where: { vaultId: f.vaultId }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    expect(await markVersionStaleness(f.vaultId, db)).toEqual([]);
  });
  it('demotes using live supported source families and preserves the concept file', async () => {
    const f = await fixture();
    const entity = f.entities[0]!;
    await f.evidence(f.assertions[0]!.id, 0);
    const second = await db.vaultAssertion.create({ data: { ...f.assertions[0]!, id: `asr_${randomUUID()}`, predicate: 'related_to' } });
    await f.evidence(second.id, 1);
    await promoteEntity(entity.id, f.vaultId, db);
    await mkdir(join(f.root, 'wiki/concepts'), { recursive: true });
    const page = join(f.root, 'wiki/concepts/a.md');
    await writeFile(page, 'Historical concept');
    expect(await demoteLonelyConcepts(f.vaultId, db)).toEqual({ demoted: [], pagesToRemove: [] });
    await db.vaultAssertion.delete({ where: { id: second.id } });
    expect(await demoteLonelyConcepts(f.vaultId, db)).toEqual({ demoted: [entity.id], pagesToRemove: ['wiki/concepts/a.md'] });
    expect(await db.vaultEntityCandidate.findUniqueOrThrow({ where: { id: entity.id } })).toMatchObject({ status: 'candidate', promotedPageId: null, familyIdsJson: [f.sources[0]!.familyId] });
    expect(await readFile(page, 'utf8')).toBe('Historical concept');
    await expect(promoteEntity(entity.id, f.vaultId, db)).rejects.toThrow('PROMOTION_INELIGIBLE');
    expect(await demoteLonelyConcepts(f.vaultId, db)).toEqual({ demoted: [], pagesToRemove: [] });
  });
});
