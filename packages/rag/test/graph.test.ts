import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.mock('@aichat/db', () => ({ prisma: {} }));
vi.mock('../src/compile/deepseek', () => ({ deepseekJson: vi.fn() }));
import { extractChunk, matchEntity, validateExtraction } from '../src/graph/extract';
import { DEFAULT_ONTOLOGY, normalizeName } from '../src/graph/ontology';
import { deleteGraphSource, recallEntities, storeGraph } from '../src/graph/store-graph';
import type { GraphDatabase, GraphSource } from '../src/graph/store-graph';
import { oneHop, rankChunks } from '../src/graph/one-hop';

const text = 'Alice develops Widget.';
const person = { key: 'a', name: 'Alice', type: '人物', context: 'Alice, the Widget product developer', aliases: ['AL'], start: 0, end: 5, evidenceText: 'Alice' };
const product = { key: 'b', name: 'Widget', type: '产品', context: 'Widget, the product developed by Alice', aliases: [], start: 15, end: 21, evidenceText: 'Widget' };
const relation = { subject: 'a', predicate: 'develops', object: 'b', direction: 'directed' as const, start: 0, end: 22, evidenceText: text, timeQualifier: null, conditionQualifier: null };
const extraction = { entities: [person, product], relations: [relation], rejected: [] };
const source: GraphSource = { kbId: 'kb', generationId: 'gen', documentId: 'doc1', sourceVersionId: 'version1', chunkId: 'chunk1', text };
const options = { kbId: 'kb', generationId: 'gen', userId: 'user', conversationId: 'session', query: 'Alice' };
const migration = readFileSync(new URL('../../db/prisma/migrations/20260924010000_entity_graph/migration.sql', import.meta.url), 'utf8');

// Small stateful SQL port: exercises writer replay/source cleanup without a DB or network.
function memory() {
  const entities: { id: string; type: string; context: string; canonicalName: string }[] = [];
  const aliases: { entityId: string; normalized: string }[] = [];
  const mentions: { entityId: string; documentId: string; chunkId: string; start: number }[] = [];
  const relations = new Map<string, string>();
  const evidence: { relationId: string; documentId: string; chunkId: string }[] = [];
  const facts: { claim: string; sources: string[] }[] = [];
  const query = vi.fn(async (sql: string, ...v: unknown[]): Promise<unknown> => {
    if (sql.includes('SELECT c.id FROM "Chunk"')) return [{ id: v[0] }];
    if (sql.includes('m.start FROM "EntityMention"')) return mentions.filter(m => m.chunkId === v[2]).map(m => ({ ...entities.find(e => e.id === m.entityId), start: m.start }));
    if (sql.includes('SELECT DISTINCT e.id')) return entities.filter(e => aliases.some(a => a.entityId === e.id && (v[1] as string[]).includes(a.normalized)));
    if (sql.includes('INSERT INTO "EntityRelation"')) {
      const key = JSON.stringify([v[2], ...v.slice(4)]);
      if (!relations.has(key)) relations.set(key, v[0] as string);
      return [{ id: relations.get(key) }];
    }
    return [{ id: 'kb' }];
  });
  const execute = vi.fn(async (sql: string, ...v: unknown[]) => {
    if (sql.includes('INSERT INTO "Entity" ')) entities.push({ id: v[0] as string, canonicalName: v[2] as string, type: v[3] as string, context: v[4] as string });
    if (sql.includes('INSERT INTO "EntityAlias"')) aliases.push({ entityId: v[1] as string, normalized: v[3] as string });
    if (sql.includes('INSERT INTO "EntityMention"')) mentions.push({ entityId: v[3] as string, documentId: v[4] as string, chunkId: v[5] as string, start: v[7] as number });
    if (sql.includes('INSERT INTO "RelationEvidence"')) evidence.push({ relationId: v[1] as string, documentId: v[2] as string, chunkId: v[4] as string });
    if (sql.startsWith('DELETE FROM "EntityMention"')) for (let i = mentions.length - 1; i >= 0; i--) { if (v.length === 3 ? mentions[i]!.chunkId === v[2] : mentions[i]!.documentId === v[1]) mentions.splice(i, 1); }
    if (sql.startsWith('DELETE FROM "RelationEvidence"')) for (let i = evidence.length - 1; i >= 0; i--) { if (v.length === 3 ? evidence[i]!.chunkId === v[2] : evidence[i]!.documentId === v[1]) evidence.splice(i, 1); }
    if (sql.startsWith('DELETE FROM "EntityRelation"')) for (const [key, id] of relations) if (!evidence.some(e => e.relationId === id)) relations.delete(key);
    if (sql.startsWith('DELETE FROM "DerivedFact"') && sql.includes('cardinality')) for (let i = facts.length - 1; i >= 0; i--) if (facts[i]!.sources.every(s => s === v[1])) facts.splice(i, 1);
    if (sql.startsWith('UPDATE "DerivedFact"')) for (const f of facts) f.sources = f.sources.filter(s => s !== v[1]);
    return 1;
  });
  const db: GraphDatabase = { $queryRawUnsafe: <T>(sql: string, ...v: unknown[]) => query(sql, ...v) as Promise<T>, $executeRawUnsafe: execute, $transaction: async run => run(db) };
  return { db, query, execute, entities, aliases, mentions, relations, evidence, facts };
}
function hopDb(run: (sql: string, values: unknown[]) => unknown | Promise<unknown>): GraphDatabase {
  const db: GraphDatabase = { $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => await run(sql, values) as T, $executeRawUnsafe: async () => 1, $transaction: async fn => fn(db) };
  return db;
}

it('a: rejects illegal types, direction, endpoint types and out-of-range spans; mocks DeepSeek', async () => {
  const bad = { entities: [...extraction.entities, { ...person, key: 'bad', type: '地点' }, { ...product, key: 'outside', end: 99 }], relations: [relation, { ...relation, direction: 'symmetric' }, { ...relation, end: 99 }, { ...relation, subject: 'b' }] };
  const complete = vi.fn(async () => ({ content: JSON.stringify(bad), inputTokens: 1, outputTokens: 2 }));
  const result = await extractChunk('user', text, DEFAULT_ONTOLOGY, undefined, complete);
  expect(result.entities).toHaveLength(2); expect(result.relations).toHaveLength(1); expect(result.rejected).toHaveLength(5);
  expect(complete.mock.calls).toHaveLength(1);
  expect(validateExtraction(null, text, DEFAULT_ONTOLOGY).rejected).toEqual(['invalid_root']);
});
it('b: same name with different contexts creates separate identities; aliases recall all candidates', async () => {
  const m = memory(); await storeGraph(source, extraction, DEFAULT_ONTOLOGY, m.db);
  const changed = { ...person, context: 'Alice, another person in a different organization' };
  await storeGraph({ ...source, chunkId: 'chunk2' }, { entities: [changed], relations: [], rejected: [] }, DEFAULT_ONTOLOGY, m.db);
  const candidates = await recallEntities(m.db, 'kb', ['AL']);
  expect(candidates).toHaveLength(2); expect(matchEntity(changed, candidates)?.context).toBe(changed.context);
  expect(matchEntity({ ...person, context: 'unclear' }, candidates)).toBeUndefined();
  expect(normalizeName(' ＡＬ ')).toBe('al');
});
it('c: replaying the same chunk preserves entity IDs and replaces mentions/evidence', async () => {
  const m = memory(); const short = { ...extraction, entities: [{ ...person, context: 'short' }, product] };
  await storeGraph(source, short, DEFAULT_ONTOLOGY, m.db); const ids = m.entities.map(e => e.id);
  await storeGraph(source, short, DEFAULT_ONTOLOGY, m.db);
  expect(m.entities.map(e => e.id)).toEqual(ids); expect(m.mentions).toHaveLength(2); expect(m.evidence).toHaveLength(1);
  expect(m.relations.size).toBe(1); expect(migration).toContain('NULLS NOT DISTINCT');
  expect(migration).toContain('GRAPH_EVIDENCE_SCOPE');
});
it('d: two sources share one relation, independent source removal retains remaining evidence', async () => {
  const m = memory(); await storeGraph(source, extraction, DEFAULT_ONTOLOGY, m.db);
  await storeGraph({ ...source, documentId: 'doc2', sourceVersionId: 'v2', chunkId: 'c2' }, extraction, DEFAULT_ONTOLOGY, m.db);
  expect(m.relations.size).toBe(1); expect(m.evidence).toHaveLength(2);
  await deleteGraphSource('kb', 'doc1', m.db); expect(m.relations.size).toBe(1); expect(m.evidence).toHaveLength(1);
  await deleteGraphSource('kb', 'doc2', m.db); expect(m.relations.size).toBe(0);
  expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
});
it('e: permission check denies inaccessible KB/session and scopes each read', async () => {
  const queries: string[] = [];
  const db = hopDb((sql, v) => { queries.push(sql); if (sql.includes('set_config')) return []; if (sql.includes('SELECT k.id')) { expect(v).toEqual(['kb', 'user', 'session', 'gen']); expect(sql).toContain('c."ownerId"=$2'); return []; } throw new Error('must not read graph'); });
  expect(await oneHop(options, db)).toEqual({ chunks: [], reason: 'forbidden' }); expect(queries).toHaveLength(2);
});
it('f: enforces 5 entities/10 relations/30 unique chunks with deterministic ordering and filters', async () => {
  let calls = 0;
  const db = hopDb((sql, v) => {
    if (sql.includes('set_config')) return [];
    if (sql.includes('SELECT k.id')) return [{ id: 'kb' }];
    if (sql.includes('SELECT e.id,count')) { expect(sql).toContain('LIMIT 5'); return Array.from({ length: 8 }, (_, i) => ({ id: `e${i}` })); }
    expect(sql).toContain('LIMIT 10'); expect(sql).toContain('c."kbId"=$1'); expect(v.slice(3)).toEqual(['outgoing', ['develops'], '2026', null]); calls++;
    return Array.from({ length: 40 }, (_, i) => ({ chunkId: `c${i.toString().padStart(2, '0')}`, text: 'text', entityId: v[2] as string, evidenceCount: 40 - i, priority: 0 }));
  });
  const result = await oneHop({ ...options, direction: 'outgoing', predicates: ['develops'], timeQualifier: '2026' }, db);
  expect(calls).toBe(5); expect(result.chunks).toHaveLength(30); expect(result.chunks[0]?.entityId).toBe('e0');
  expect(rankChunks([...result.chunks].reverse())).toEqual(result.chunks);
});
it('g: elapsed deadline and stalled database return timeout without throwing', async () => {
  const db = hopDb(() => new Promise(() => {}));
  expect(await oneHop({ ...options, deadline: Date.now() - 1 }, db)).toEqual({ chunks: [], reason: 'timeout' });
  expect(await oneHop({ ...options, deadline: Date.now() + 10 }, db)).toEqual({ chunks: [], reason: 'timeout' });
  expect((await oneHop(options, hopDb(() => { throw new Error('offline'); }))).reason).toBe('error');
});
it('h: removing a dependency preserves a multi-source claim and removes single-source claims', async () => {
  const m = memory(); m.facts.push({ claim: 'shared', sources: ['doc1', 'doc2'] }, { claim: 'single', sources: ['doc1'] });
  await deleteGraphSource('kb', 'doc1', m.db);
  expect(m.facts).toEqual([{ claim: 'shared', sources: ['doc2'] }]);
  expect(migration).toContain('BEFORE DELETE ON "Document"');
});
