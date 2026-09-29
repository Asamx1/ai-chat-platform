import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ embed: vi.fn(), query: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: {
  knowledgeBase: { findMany: vi.fn(async () => [{ id: 'kb', activeGenerationId: null }]) },
  $queryRawUnsafe: mocks.query,
} }));
vi.mock('../src/embed', async importOriginal => ({
  ...await importOriginal<typeof import('../src/embed')>(), embed: mocks.embed,
}));
import * as rag from '@aichat/rag';

const budget = 8_000;
const hit = { documentId: 'doc', ordinal: 0, name: 'fact.txt', text: 'The answer is 42', distance: 0.1 };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.embed.mockReset();
  mocks.query.mockReset().mockResolvedValue([hit]);
  for (const name of ['RAG_HYBRID', 'RAG_MMR', 'RAG_SMALL2BIG', 'RAG_RERANK', 'RAG_REWRITE']) vi.stubEnv(name, '0');
  vi.stubEnv('RAG_GRAPH', 'false');
  // Node's native AbortSignal.timeout does not use Vitest's virtual clock.
  // The embed mock never observes it; exercise retrieve's own deadline race.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('exports RETRIEVAL_BUDGET_MS = 8000 from @aichat/rag', () => {
  // Namespace access keeps the pre-A2 missing export an assertion failure.
  expect(Reflect.get(rag, 'RETRIEVAL_BUDGET_MS')).toBe(budget);
});

it('derives retrieve deadline from the shared RETRIEVAL_BUDGET_MS constant', () => {
  const source = readFileSync(new URL('../src/retrieve.ts', import.meta.url), 'utf8');
  expect(/Date\.now\(\)\s*\+\s*RETRIEVAL_BUDGET_MS\b/.test(source),
    'retrieve must derive its deadline from Date.now() + RETRIEVAL_BUDGET_MS').toBe(true);
});

it('keeps a stalled embed pending through 7999ms and rejects at 8000ms', async () => {
  mocks.embed.mockImplementation(() => new Promise(() => {}));
  const settled = vi.fn();
  // Attach the rejection handler before advancing timers to avoid unhandled rejections.
  const pending = rag.retrieve('owner', 'conversation', 'query').then(
    hits => { settled('READY'); return hits; },
    error => { settled('RAG_TIMEOUT'); return error; },
  );
  await vi.advanceTimersByTimeAsync(budget - 1);
  expect(mocks.embed).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual(new Error('RAG_TIMEOUT'));
  expect(mocks.query).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('returns hits when embed takes 4000ms within the retrieval budget', async () => {
  mocks.embed.mockImplementation(() => new Promise(resolve => {
    setTimeout(() => resolve([Array(1024).fill(0.1)]), 4_000);
  }));
  const pending = rag.retrieve('owner', 'conversation', 'query').catch(error => error);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await pending).toEqual([hit]);
  expect(vi.getTimerCount()).toBe(0);
});
