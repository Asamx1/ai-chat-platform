import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { query, embedding } = vi.hoisted(() => ({ query: vi.fn().mockResolvedValue([]), embedding: Array(1024).fill(0.1) }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRawUnsafe: query } }));
vi.mock('../src/embed', async importOriginal => ({
  ...await importOriginal<typeof import('../src/embed')>(), embed: vi.fn(async () => [embedding]),
}));
import { maximalMarginalRelevance, reciprocalRankFusion, retrieve } from '../src/retrieve';
beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  for (const name of ['RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG']) vi.stubEnv(name, '0');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it('binds vector, owner, conversation and model; projects no embedding', async () => {
  const owner = "owner'; DROP TABLE x;--";
  const conversation = "conversation' OR true--";
  await retrieve(owner, conversation, 'query');
  const [sql, vector, user, id, model] = query.mock.calls[0]!;
  expect(sql).not.toContain(owner);
  expect(sql).not.toContain(conversation);
  expect(sql).toContain('k."userId"=$2 AND v."ownerId"=$2');
  expect(sql).toContain("d.status='READY' AND d.model=$4");
  expect(sql).toContain('<=> $1::vector(1024)');
  expect(sql).toContain('LIMIT 5');
  expect(sql).not.toMatch(/SELECT\s+\*|c\.embedding\s*,/);
  expect([vector, user, id, model]).toEqual([JSON.stringify(embedding), owner, conversation, process.env.EMBEDDING_MODEL || 'bge-m3:latest']);
});


const candidate = (chunkId: string, distance = 0.1) => ({
  chunkId, documentId: 'doc', ordinal: 1, name: 'document', text: chunkId,
  distance, parentId: null as string | null, kind: 'CHILD', embedding: JSON.stringify(embedding),
});
const publicHit = (text: string, distance = 0.1) => ({ documentId: 'doc', ordinal: 1, name: 'document', text, distance });

it('fuses ranked lists with k=60, deduplicating votes within each list', () => {
  const a = candidate('a', 0.1), b = candidate('b', 0.2), c = candidate('c', 0.3);
  expect(reciprocalRankFusion([[a, a, b], [b, c]]).map(hit => hit.chunkId)).toEqual(['b', 'a', 'c']);
});

it('MMR suppresses redundant vectors and preserves input on ties', () => {
  const items = [
    { id: 'a', embedding: [1, 0] }, { id: 'duplicate', embedding: [1, 0] },
    { id: 'diverse', embedding: [0, 1] }, { id: 'last', embedding: [1, 0] },
  ];
  expect(maximalMarginalRelevance(items, 2).map(item => item.id)).toEqual(['a', 'diverse']);
});

it('hybrid off uses only vector retrieval', async () => {
  query.mockResolvedValue([publicHit('vector')]);
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('vector')]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![0]).not.toContain('ts_rank');
});

it('defaults to hybrid, MMR and authorized parent expansion without returning embeddings', async () => {
  for (const name of ['RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG']) vi.stubEnv(name, undefined);
  const child = { ...candidate('child'), parentId: 'parent' };
  query.mockResolvedValueOnce([child]).mockResolvedValueOnce([child])
    .mockResolvedValueOnce([{ ...candidate('parent'), ordinal: 9, text: 'parent context', distance: 0.9 }]);
  expect(await retrieve('owner', 'conversation', 'search text')).toEqual([
    { ...publicHit('parent context'), ordinal: 9 },
  ]);
  const [sql, , owner, conversation, , text] = query.mock.calls[1]!;
  expect(sql).toContain("c.tsv @@ plainto_tsquery('pg_catalog.simple', $5)");
  expect(sql).toContain("ts_rank(c.tsv, plainto_tsquery('pg_catalog.simple', $5)) DESC");
  expect(sql).toContain('k."userId"=$2 AND v."ownerId"=$2');
  expect(sql).toContain("d.status='READY' AND d.model=$4");
  expect([owner, conversation, text]).toEqual(['owner', 'conversation', 'search text']);
  expect(query.mock.calls[2]![0]).toContain("c.kind='PARENT'");
});

it('runs lexical and vector searches concurrently and keeps fusion order with MMR off', async () => {
  vi.stubEnv('RAG_HYBRID', '1');
  const a = candidate('a'), b = candidate('b', 0.2);
  let release: (rows: ReturnType<typeof candidate>[]) => void = () => {};
  query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockImplementationOnce(async () => { release([a, b]); return [b]; });
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('b', 0.2), publicHit('a')]);
  expect(query).toHaveBeenCalledTimes(2);
});

it('keeps a child when its parent is missing or belongs to another document', async () => {
  vi.stubEnv('RAG_SMALL2BIG', '1');
  const child = { ...candidate('child'), parentId: 'parent' };
  for (const parents of [[], [{ ...candidate('parent'), documentId: 'other' }]]) {
    query.mockResolvedValueOnce([child]).mockResolvedValueOnce(parents);
    expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('child')]);
  }
});

it('deduplicates expanded parents and keeps the best ranked child distance', async () => {
  vi.stubEnv('RAG_SMALL2BIG', '1');
  query.mockResolvedValueOnce([
    { ...candidate('a'), parentId: 'parent' }, { ...candidate('b', 0.2), parentId: 'parent' },
  ]).mockResolvedValueOnce([{ ...candidate('parent'), ordinal: 9 }]);
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([{ ...publicHit('parent'), ordinal: 9 }]);
});

it('falls back to vector top-5 when lexical search fails', async () => {
  vi.stubEnv('RAG_HYBRID', '1');
  const rows = Array.from({ length: 6 }, (_, i) => candidate(String(i)));
  query.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('lexical unavailable'));
  const hits = await retrieve('owner', 'conversation', 'query');
  expect(hits).toEqual(rows.slice(0, 5).map(row => publicHit(row.text)));
  expect(query).toHaveBeenCalledTimes(2);
});

it('falls back on malformed MMR vectors and parent lookup failure', async () => {
  vi.stubEnv('RAG_MMR', '1');
  query.mockResolvedValueOnce([{ ...candidate('child'), embedding: 'invalid' }]);
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('child')]);
  vi.stubEnv('RAG_MMR', '0');
  vi.stubEnv('RAG_SMALL2BIG', '1');
  query.mockResolvedValueOnce([{ ...candidate('child'), parentId: 'parent' }])
    .mockRejectedValueOnce(new Error('parent lookup failed'));
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('child')]);
});

it('returns the vector baseline when lexical search times out', async () => {
  vi.useFakeTimers();
  vi.stubEnv('RAG_HYBRID', '1');
  query.mockResolvedValueOnce([candidate('child')]).mockImplementationOnce(() => new Promise(() => {}));
  const pending = retrieve('owner', 'conversation', 'query');
  await vi.advanceTimersByTimeAsync(2800);
  expect(await pending).toEqual([publicHit('child')]);
});

it('retries pure vector SQL when enhanced vector retrieval fails', async () => {
  vi.stubEnv('RAG_MMR', '1');
  query.mockRejectedValueOnce(new Error('enhanced query failed')).mockResolvedValueOnce([publicHit('baseline')]);
  expect(await retrieve('owner', 'conversation', 'query')).toEqual([publicHit('baseline')]);
  expect(query.mock.calls[1]![0]).toContain('LIMIT 5');
  expect(query.mock.calls[1]![0]).not.toContain('AS embedding');
});
