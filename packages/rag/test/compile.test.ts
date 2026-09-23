import { afterEach, expect, it, vi } from 'vitest';
const { query, execute, transaction } = vi.hoisted(() => {
  const query = vi.fn(); const execute = vi.fn().mockResolvedValue(1);
  return { query, execute, transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRawUnsafe: query, $executeRawUnsafe: execute })) };
});
vi.mock('@aichat/db', () => ({ prisma: { $transaction: transaction, $queryRawUnsafe: query, $executeRawUnsafe: execute,
  knowledgeBase: { findMany: vi.fn(async () => [{ id: 'kb', activeGenerationId: null }]) } } }));
import { compileSummary, verifyFacts } from '../src/compile/summary';
import { consumeCompileOutbox, summaryIdempotencyKey } from '../src/compile/compile-job';
import { allowedKinds, retrieve } from '../src/retrieve';
vi.mock('../src/embed', () => ({ embeddingModel: () => 'test', validateVector: vi.fn(), embed: vi.fn(async () => [Array(1024).fill(0.1)]) }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it('validates evidence and removes unmatched facts from the published summary', async () => {
  const chunks = [{ id: 'chunk', ordinal: 2, text: 'The value is 42.\nThe sky is blue.' }];
  const result = await compileSummary('user', chunks, undefined, vi.fn(async () => ({
    content: JSON.stringify({ summary: 'The value is 42.', facts: [
      { claim: 'value', quote: 'value is 42', chunkOrdinal: 2 },
      { claim: 'false', quote: 'value is 99', chunkOrdinal: 2 },
    ] }), inputTokens: 20, outputTokens: 10,
  })));
  expect(result.facts).toEqual([{ claim: 'value', quote: 'value is 42', sourceChunkId: 'chunk', spanStart: 4, spanEnd: 15 }]);
  expect(result.rejectedFacts).toBe(1);
  expect(result.markdown).not.toContain('value is 99');
  expect(verifyFacts([{ claim: 'sky', quote: 'sky is  blue', chunkOrdinal: 2 }], chunks).facts).toHaveLength(1);
});

it('replays outbox with a stable unique job key and acknowledges only after insert', async () => {
  query.mockResolvedValue([{ id: 'event', kbId: 'kb', documentId: 'doc', sourceVersionId: 'version', generationId: 'generation' }]);
  await consumeCompileOutbox();
  await consumeCompileOutbox();
  expect(execute).toHaveBeenCalledTimes(4);
  expect(execute.mock.calls[0]![0]).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING');
  expect(execute.mock.calls[0]![7]).toBe(summaryIdempotencyKey('version', 'generation'));
  expect(execute.mock.calls[1]![0]).toContain('"processedAt"=clock_timestamp()');
});

it('keeps the global wiki switch ahead of requested kinds', () => {
  vi.stubEnv('RAG_WIKI', 'false');
  expect(allowedKinds({ includeKinds: ['WIKI_SUMMARY'] })).toEqual(['SOURCE']);
  vi.stubEnv('RAG_WIKI', 'true');
  expect(allowedKinds({ includeKinds: ['SOURCE', 'WIKI_SUMMARY'] })).toEqual(['SOURCE', 'WIKI_SUMMARY']);
});

it('filters the pure vector fallback by SOURCE when Wiki is off', async () => {
  vi.stubEnv('RAG_WIKI', 'false');
  for (const name of ['RAG_REWRITE', 'RAG_RERANK', 'RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG']) vi.stubEnv(name, '0');
  query.mockResolvedValue([]);
  await retrieve('user', 'conversation', 'query', { includeKinds: ['WIKI_SUMMARY'] });
  expect(query.mock.calls.at(-1)![0]).toContain("d.kind IN ('SOURCE')");
});
