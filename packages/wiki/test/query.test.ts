import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { answerStrict, answerWithInference, loadVaultContext, retrieveEvidence } from '../src/query.js';
import { registerSource, sha256 } from '../src/scan.js';
import type { Llm } from '../src/extract.js';

const testUrl = process.env.AICHAT_TEST_DB_URL;
describe.skipIf(!testUrl)('strict query with real PostgreSQL', () => {
  let db: PrismaClient;
  let pool: import('pg').Pool;
  const schema = `wiki_query_${randomUUID().replaceAll('-', '')}`;
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
      for (const migration of ['20260925000000_vault_tables', '20260925010000_entity_candidate_type']) {
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
    const root = await mkdtemp(join(tmpdir(), 'wiki-query-')); roots.push(root);
    await mkdir(join(root, 'wiki'), { recursive: true });
    await mkdir(join(root, 'schema'));
    await writeFile(join(root, 'CLAUDE.md'), 'Only answer from evidence. Preserve scope.');
    await writeFile(join(root, 'wiki/index.md'), '# Alpha taxonomy');
    for (const file of ['ontology.yaml', 'constraints.yaml', 'inference-rules.yaml']) {
      await writeFile(join(root, 'schema', file), await readFile(new URL(`../../ontology/defaults/${file}`, import.meta.url)));
    }
    const source = (await registerSource({ title: 'Taxonomy', filePath: 'raw/articles/taxonomy.txt', sha256: sha256('taxonomy'), bytes: 8n, mimeType: 'text/plain' }, vaultId, db)).source;
    const entities = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      entities.push(await db.vaultEntityCandidate.create({ data: { vaultId, canonicalName: JSON.stringify(['Class', name.toLowerCase()]), type: 'Class',
        status: 'candidate', firstSourceId: source.id, familyIdsJson: [source.familyId], aliasesJson: name === 'Alpha' ? ['A类'] : [] } }));
    }
    const assertions = [];
    for (let i = 0; i < 2; i++) {
      const assertion = await db.vaultAssertion.create({ data: { id: `asr_${randomUUID()}`, vaultId, subjectId: entities[i]!.id,
        objectId: entities[i + 1]!.id, predicate: 'subclass_of', polarity: true, conditions: '{}', status: 'supported', origin: 'sourced', revision: 'rev-002', ontologyVersion: '1.0.0' } });
      await db.vaultEvidence.create({ data: { vaultId, assertionId: assertion.id, sourceId: source.id, sourceSha256: source.sha256,
        locatorKind: 'page', locatorJson: JSON.stringify({ kind: 'page', page: i + 1 }), quote: i === 0 ? 'Alpha is a subclass of Beta.' : 'Beta is a subclass of Gamma.', stance: 'supports' } });
      assertions.push(assertion);
    }
    await db.vaultRelease.create({ data: { vaultId, revision: 'rev-002', ontologyVersion: '1.0.0', rulesVersion: '1.0.0', filesJson: [], baselineHash: sha256('baseline'), status: 'committed' } });
    return { vaultId, root, source, entities, assertions };
  }
  it('reads all three schema versions and rereads rules on every query', async () => {
    const f = await fixture();
    expect((await loadVaultContext(f.root)).versions).toEqual({ ontology: '1.0.0', constraints: '1.0.0', inferenceRules: '1.0.0' });
    await writeFile(join(f.root, 'CLAUDE.md'), 'NEW RULE');
    const llm = vi.fn<Llm>(async request => {
      expect(request.system).toContain('NEW RULE');
      return { answer: `Alpha is a subclass of Beta. [${f.assertions[0]!.id}]`, usedAssertionIds: [f.assertions[0]!.id] };
    });
    expect((await answerStrict('Alpha', f.vaultId, f.root, db, { llm })).kind).toBe('sourced');
  });
  it('returns NO_EVIDENCE without calling the model for an unmatched question', async () => {
    const f = await fixture(); const llm = vi.fn<Llm>();
    expect(await answerStrict('zzzzquasar', f.vaultId, f.root, db, { llm })).toEqual({ kind: 'unknown', reason: 'NO_EVIDENCE', answer: null, citations: [] });
    expect(llm).not.toHaveBeenCalled();
  });
  it('links normalized canonical names and aliases, expands relations and returns complete citations', async () => {
    const f = await fixture();
    const set = await retrieveEvidence('Ａ类', f.vaultId, db, { vaultPath: f.root });
    expect(set.linkedEntityIds).toEqual([f.entities[0]!.id]);
    expect(set.assertions.map(a => a.id)).toEqual(expect.arrayContaining(f.assertions.map(a => a.id)));
    expect((await retrieveEvidence('Ａｌｐｈａ', f.vaultId, db, { vaultPath: f.root })).linkedEntityIds).toEqual([f.entities[0]!.id]);
    const id = f.assertions[0]!.id;
    const answer = await answerStrict('A类', f.vaultId, f.root, db, { llm: async () => ({ answer: `Alpha is a subclass of Beta. [${id}]`, usedAssertionIds: [id] }) });
    expect(answer).toMatchObject({ kind: 'sourced', revision: 'rev-002', ontologyVersion: '1.0.0', citations: [{ assertionId: id,
      quote: 'Alpha is a subclass of Beta.', locator: { kind: 'page', page: 1 }, sourceTitle: 'Taxonomy', sourceFile: 'raw/articles/taxonomy.txt', sourceId: f.source.id, origin: 'sourced' }] });
  });
  it('rejects invented IDs, empty used IDs, unlisted inline IDs and uncited lines', async () => {
    const f = await fixture(); const id = f.assertions[0]!.id;
    for (const output of [
      { answer: 'Invented [asr_missing]', usedAssertionIds: ['asr_missing'] },
      { answer: 'Free answer', usedAssertionIds: [] },
      { answer: 'Wrong [asr_missing]', usedAssertionIds: [id] },
      { answer: `Alpha [${id}]\nUncited extra claim`, usedAssertionIds: [id] },
    ]) expect((await answerStrict('Alpha', f.vaultId, f.root, db, { llm: async () => output })).kind).toBe('unknown');
  });
  it('fails closed on retrieval and model errors', async () => {
    const f = await fixture();
    expect(await answerStrict('Alpha', f.vaultId, f.root, db, { llm: async () => { throw new Error('offline'); } })).toMatchObject({ kind: 'unknown', reason: 'RETRIEVAL_FAILED' });
    await rm(join(f.root, 'schema/ontology.yaml'));
    const llm = vi.fn<Llm>();
    expect(await answerStrict('Alpha', f.vaultId, f.root, db, { llm })).toMatchObject({ kind: 'unknown', reason: 'RETRIEVAL_FAILED' });
    expect(llm).not.toHaveBeenCalled();
  });
  it('filters future revisions, invalid statuses, undeclared relations and other vaults', async () => {
    const f = await fixture(); const other = await fixture();
    await db.vaultAssertion.update({ where: { id: f.assertions[0]!.id }, data: { revision: 'rev-010' } });
    await db.vaultAssertion.update({ where: { id: f.assertions[1]!.id }, data: { status: 'invalid' } });
    expect((await retrieveEvidence('Alpha Beta', f.vaultId, db, { vaultPath: f.root })).evidence).toEqual([]);
    await db.vaultAssertion.update({ where: { id: f.assertions[0]!.id }, data: { revision: 'rev-001', predicate: 'undeclared' } });
    expect((await retrieveEvidence('Alpha Beta', f.vaultId, db, { vaultPath: f.root })).evidence).toEqual([]);
    expect((await retrieveEvidence('Alpha', other.vaultId, db, { vaultPath: other.root })).evidence.length).toBeGreaterThan(0);
  });
  it('includes candidate evidence and retrieves quotes without an entity match', async () => {
    const f = await fixture();
    await db.vaultAssertion.update({ where: { id: f.assertions[0]!.id }, data: { status: 'candidate' } });
    const set = await retrieveEvidence('subclass', f.vaultId, db, { vaultPath: f.root });
    expect(set.linkedEntityIds).toEqual([]);
    expect(set.evidence.map(e => e.assertionId)).toContain(f.assertions[0]!.id);
    await db.vaultRelease.deleteMany({ where: { vaultId: f.vaultId } });
    expect((await retrieveEvidence('Alpha', f.vaultId, db, { vaultPath: f.root })).evidence).toEqual([]);
  });
  it('marks inferred citations with premises and separates inferred answer lines', async () => {
    const f = await fixture();
    for (const mixed of [false, true]) {
      const llm: Llm = async request => {
        const payload = JSON.parse(request.system.slice(request.system.lastIndexOf('\n') + 1)) as { assertions: Array<{ id: string; origin: string }> };
        const derived = payload.assertions.find(a => a.origin === 'inferred')!;
        expect(derived).toBeDefined();
        return { answer: `${mixed ? `Alpha is a subclass of Beta. [${f.assertions[0]!.id}]\n` : ''}Alpha is a subclass of Gamma. [${derived.id}]`,
          usedAssertionIds: [...(mixed ? [f.assertions[0]!.id] : []), derived.id] };
      };
      const result = await answerWithInference('Alpha', f.vaultId, f.root, db, { llm });
      expect(result.kind).toBe(mixed ? 'mixed' : 'inferred');
      if (result.kind === 'unknown') throw new Error('Expected inferred evidence');
      expect(result.inferredParts).toHaveLength(1);
      for (const citation of result.citations.filter(c => c.origin === 'inferred')) {
        expect(citation.premiseAssertionIds).toEqual(f.assertions.map(a => a.id));
        expect(citation.locator.kind).toBe('page');
      }
    }
  });
});
