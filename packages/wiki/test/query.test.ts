import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import { answerStrict, answerWithInference, loadVaultContext, retrieveEvidence } from '../src/query.js';
import { inferAssertions, persistInferred } from '../src/infer.js';
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
  it('injects inferred assertions by default, penetrates source evidence and supports opt-out', async () => {
    const f = await fixture();
    const inferred = await inferAssertions(f.vaultId, db, { vaultPath: f.root });
    expect(await persistInferred(f.vaultId, db, inferred)).toEqual({ created: 1, updated: 0 });
    expect(await persistInferred(f.vaultId, db, inferred)).toEqual({ created: 0, updated: 1 });
    expect(await db.vaultInferredAssertion.findMany({ where: { vaultId: f.vaultId } })).toEqual([
      expect.objectContaining({ status: 'machine', derivedFromJson: f.assertions.map(a => a.id) }),
    ]);
    const embedding = { embed: async (): Promise<number[][]> => { throw new Error('offline'); } };
    const plain = await retrieveEvidence('Alpha', f.vaultId, db, { vaultPath: f.root, includeInferred: false, embedding });
    expect(plain.assertions.every(a => a.origin === 'sourced')).toBe(true);
    const llm: Llm = async request => {
      const payload = JSON.parse(request.system.slice(request.system.lastIndexOf('\n') + 1));
      const derived = payload.assertions.find((a: { origin: string }) => a.origin === 'inferred');
      expect(derived.derivedFrom).toEqual(f.assertions.map(a => a.id));
      return { answer: `Alpha is a subclass of Gamma. [${derived.id}]`, usedAssertionIds: [derived.id] };
    };
    const result = await answerStrict('Alpha', f.vaultId, f.root, db, { llm, embedding });
    expect(result.kind).toBe('inferred');
    expect(result.citations.map(c => c.sourceAssertionId)).toEqual(f.assertions.map(a => a.id));
    expect(result.citations.map(c => c.locator)).toEqual([{ kind: 'page', page: 1 }, { kind: 'page', page: 2 }]);
    expect(result.citations.map(c => c.quote)).toEqual(['Alpha is a subclass of Beta.', 'Beta is a subclass of Gamma.']);
    await answerStrict('Alpha', f.vaultId, f.root, db, { embedding, includeInferred: false, llm: async request => {
      const payload = JSON.parse(request.system.slice(request.system.lastIndexOf('\n') + 1));
      expect(payload.assertions.every((a: { origin: string }) => a.origin === 'sourced')).toBe(true);
      return { answer: '', usedAssertionIds: [] };
    } });
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
  it('links alias substrings longest first and caps links at eight with a stub answer', async () => {
    const f = await fixture();
    const names = ['检索增强生成', '检索增强', '检索', '增强生成', '增强', '生成', '检索增强生', '索增强生成', '索增强'];
    const ids: string[] = [];
    for (const name of names) {
      const entity = await db.vaultEntityCandidate.create({ data: { vaultId: f.vaultId, canonicalName: name, type: 'Concept',
        firstSourceId: f.source.id, status: 'candidate', familyIdsJson: [f.source.familyId], aliasesJson: [name] } });
      ids.push(entity.id);
    }
    const question = '检索增强生成的定义是什么？';
    const set = await retrieveEvidence(question, f.vaultId, db, { vaultPath: f.root });
    expect(set.linkedEntityIds).toHaveLength(8);
    expect(set.linkedEntityIds[0]).toBe(ids[0]);
    const llm = vi.fn<Llm>(async () => ({ answer: '', usedAssertionIds: [] }));
    expect((await answerStrict(question, f.vaultId, f.root, db, { llm })).kind).toBe('unknown');
    expect(llm).not.toHaveBeenCalled();
  });
  it('uses raw section evidence without stored quotes and invalidates cached changed content', async () => {
    const f = await fixture();
    const text = '# RAG\n检索增强生成通过检索文档辅助回答问题。';
    await mkdir(join(f.root, 'raw/articles'), { recursive: true });
    await writeFile(join(f.root, 'raw/articles/rag.md'), text);
    const source = (await registerSource({ filePath: 'raw/articles/rag.md', title: 'RAG', sha256: sha256(text),
      bytes: BigInt(Buffer.byteLength(text)), mimeType: 'text/markdown' }, f.vaultId, db)).source;
    const llm = vi.fn<Llm>(async request => {
      const payload = JSON.parse(request.system.slice(request.system.lastIndexOf('\n') + 1)) as { evidence: Array<{ assertionId: string; sourceId: string }> };
      const evidence = payload.evidence.find(e => e.sourceId === source.id)!;
      return { answer: `检索文档辅助回答问题。[${evidence.assertionId}]`, usedAssertionIds: [evidence.assertionId] };
    });
    const result = await answerStrict('检索增强生成是什么？', f.vaultId, f.root, db, { llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'sourced', citations: [{ sourceId: source.id, quote: text,
      derivedFromSection: true, locator: { kind: 'section', section: '1:RAG' } }] });
    await writeFile(join(f.root, 'raw/articles/rag.md'), text + ' changed');
    expect((await retrieveEvidence('检索增强生成是什么？', f.vaultId, db, { vaultPath: f.root })).evidence).toEqual([]);
  });
  it('ranks conditional assertions higher for version questions and admits definition values', async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const id = `asr_version_${f.vaultId}_${String(i).padStart(2, '0')}`;
      ids.push(id);
      await db.vaultAssertion.create({ data: { id, vaultId: f.vaultId, subjectId: f.entities[0]!.id,
        predicate: 'definition', value: JSON.stringify('Alpha definition'), polarity: true,
        conditions: i === 15 ? JSON.stringify({ version: 'v2' }) : '{}', status: 'candidate', origin: 'sourced', revision: 'rev-002', ontologyVersion: '1.0.0' } });
      await db.vaultEvidence.create({ data: { vaultId: f.vaultId, assertionId: id, sourceId: f.source.id,
        sourceSha256: f.source.sha256, quote: 'Alpha definition.', locatorKind: 'page', locatorJson: JSON.stringify({ kind: 'page', page: 3 + i }), stance: 'supports' } });
    }
    const plain = await retrieveEvidence('Alpha definition', f.vaultId, db, { vaultPath: f.root });
    expect(plain.assertions.map(a => a.id)).not.toContain(ids[15]);
    const ranked = await retrieveEvidence('Alpha definition 哪个版本 v2', f.vaultId, db, { vaultPath: f.root });
    expect(ranked.evidence).toHaveLength(15);
    expect(ranked.evidence[0]!.assertionId).toBe(ids[15]);
    const llm: Llm = async () => ({ answer: `Alpha definition applies to v2. [${ids[15]}]`, usedAssertionIds: [ids[15]!] });
    expect((await answerStrict('Alpha definition 哪个版本 v2', f.vaultId, f.root, db, { llm })).kind).toBe('sourced');
  });

});
