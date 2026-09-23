import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { queryRaw, executeRaw, hop, embedding } = vi.hoisted(() => ({
  queryRaw: vi.fn(), executeRaw: vi.fn(), hop: vi.fn(), embedding: Array(1024).fill(0.1),
}));
vi.mock('@aichat/db', () => ({ prisma: {
  $queryRawUnsafe: queryRaw, $executeRawUnsafe: executeRaw,
  knowledgeBase: { findMany: vi.fn(async () => [{ id: 'kb', activeGenerationId: 'gen' }]) },
} }));
vi.mock('../src/embed', async original => ({ ...await original<typeof import('../src/embed')>(), embed: vi.fn(async () => [embedding]) }));
vi.mock('../src/graph/one-hop', () => ({ oneHop: hop }));

import { quotaCandidates, retrieve } from '../src/retrieve';
import { enqueueEntityPages, entityPageKey, renderEntityPage } from '../src/compile/entity-page';

const candidate = (id: string, documentKind = 'SOURCE') => ({
  chunkId: id, documentId: id, ordinal: 0, name: id, text: id, distance: 0.1,
  headingPath: null, documentKind, parentId: null, kind: 'STANDALONE', embedding: JSON.stringify(embedding),
});
beforeEach(() => {
  queryRaw.mockReset().mockResolvedValue([]); executeRaw.mockReset().mockResolvedValue(1); hop.mockReset().mockResolvedValue({ chunks: [], reason: 'ok', entities: 0, relations: 0 });
  for (const name of ['RAG_REWRITE', 'RAG_RERANK', 'RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG']) vi.stubEnv(name, '0');
  vi.stubEnv('RAG_WIKI', 'false'); vi.stubEnv('RAG_GRAPH', 'false');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it('keeps graph fully off in the pure vector path', async () => {
  queryRaw.mockResolvedValueOnce([candidate('vector')]);
  const hits = await retrieve('user', 'conversation', 'alias');
  expect(hop).not.toHaveBeenCalled();
  expect(hits.map(h => h.text)).toEqual(['vector']);
  expect(hits.graphPath.used).toBe(false);
});

it('fuses alias relation evidence chunks with an independent graph weight', async () => {
  vi.stubEnv('RAG_GRAPH', 'true');
  queryRaw.mockResolvedValue([candidate('vector'), candidate('other')]);
  hop.mockResolvedValue({ reason: 'ok', entities: 1, relations: 1, chunks: [{
    chunkId: 'graph', documentId: 'graph', ordinal: 0, name: 'graph', text: 'graph',
    documentKind: 'SOURCE', entityId: 'entity', evidenceCount: 2, priority: 0,
  }] });
  const low = await retrieve('user', 'conversation', 'alias', { graphWeight: 0.1 });
  const high = await retrieve('user', 'conversation', 'alias', { graphWeight: 2 });
  expect(low.map(h => h.text)).toContain('graph');
  expect(high[0]?.text).toBe('graph');
  expect(high.graphPath).toMatchObject({ used: true, entities: 1, relations: 1 });
  expect(hop.mock.calls[0]?.[0]).toMatchObject({ kbId: 'kb', generationId: 'gen', userId: 'user', conversationId: 'conversation' });
});

it('records a 300ms graph timeout while returning vector results', async () => {
  vi.useFakeTimers(); vi.stubEnv('RAG_GRAPH', 'true');
  queryRaw.mockResolvedValue([candidate('vector')]); hop.mockImplementation(() => new Promise(() => {}));
  const pending = retrieve('user', 'conversation', 'alias');
  await vi.advanceTimersByTimeAsync(301);
  const hits = await pending;
  expect(hits.map(h => h.text)).toEqual(['vector']);
  expect(hits.graphPath).toMatchObject({ used: false, error: 'timeout' });
  expect(hits.graphPath.timeoutMs).toBeLessThanOrEqual(300);
});

it('applies source, summary and entity quotas with per source deduplication', () => {
  const rows = [candidate('s1'), candidate('s1'), candidate('s2'), candidate('s3'), candidate('s4'),
    candidate('w1', 'WIKI_SUMMARY'), candidate('w2', 'WIKI_SUMMARY'), candidate('e1', 'WIKI_ENTITY')];
  expect(quotaCandidates(rows, ['SOURCE', 'WIKI_SUMMARY', 'WIKI_ENTITY'], 5).map(r => r.documentId)).toEqual(['s1', 's2', 's3', 'w1', 'e1']);
});

it('renders cited entity facts and relations and queues one page per generation entity', async () => {
  const evidence = [{ documentId: 'source', chunkId: 'chunk', quote: 'quoted source' }];
  const markdown = renderEntityPage({ id: 'e1', canonicalName: 'Alpha', type: 'Thing', context: 'context', aliases: ['A'] },
    [{ predicate: 'uses', subjectId: 'e1', subjectName: 'Alpha', objectId: 'e2', objectName: 'Beta', evidence }],
    [{ claim: 'Alpha uses Beta', evidence }]);
  expect(markdown).toContain('[[e2|Beta]]');
  expect(markdown).toContain('## 关键事实');
  expect(markdown.match(/quoted source/g)).toHaveLength(2);
  expect(entityPageKey('kb', 'gen', 'e1')).toBe('wiki/kb/gen/e1.md');
  queryRaw.mockResolvedValueOnce([{ id: 'e1' }]);
  expect(await enqueueEntityPages('kb', 'gen', 'version')).toBe(1);
  expect(executeRaw).toHaveBeenCalledTimes(1);
  expect(executeRaw.mock.calls[0]?.[0]).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING');
});

it('does not expose graph candidates for a forbidden session or KB', async () => {
  vi.stubEnv('RAG_GRAPH', 'true'); queryRaw.mockResolvedValue([candidate('vector')]);
  hop.mockResolvedValue({ reason: 'forbidden', chunks: [] });
  const hits = await retrieve('user', 'unauthorized', 'alias');
  expect(hits.map(h => h.text)).toEqual(['vector']);
  expect(hits.graphPath).toMatchObject({ used: false, error: 'forbidden' });
});
