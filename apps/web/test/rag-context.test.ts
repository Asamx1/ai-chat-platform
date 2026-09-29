import { afterEach, expect, it, vi } from 'vitest';
import { RETRIEVAL_BUDGET_MS } from '../../../packages/rag/src/llm-json';
const { query, retrieve } = vi.hoisted(() => ({ query: vi.fn(), retrieve: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRaw: query } }));
vi.mock('@aichat/rag', () => ({ retrieve }));
import { retrieveContext, revalidateContext } from '../src/lib/rag-context';

const hit = { documentId: 'doc', ordinal: 0, name: 'fact', text: '42', distance: 0.1 };
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

it.each(['retrieve', 'revalidate'] as const)('%s uses the shared eight-second deadline and preserves degradation', async operation => {
  vi.useFakeTimers();
  expect(RETRIEVAL_BUDGET_MS).toBe(8_000);
  query.mockImplementation(() => new Promise(() => {}));
  const pending = operation === 'retrieve'
    ? retrieveContext('user', 'conversation', 'question')
    : revalidateContext('user', 'conversation', { status: 'READY', hits: [hit] });
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(RETRIEVAL_BUDGET_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ status: 'RAG_UNAVAILABLE', hits: [] });
});

it('allows retrieval taking longer than the old three-second budget', async () => {
  vi.useFakeTimers();
  query.mockResolvedValue([{ kbId: 'kb' }]);
  retrieve.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([hit]), 4_000)));
  const pending = retrieveContext('user', 'conversation', 'question');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await pending).toEqual({ status: 'READY', hits: [hit] });
});
