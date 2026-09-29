import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mounted: vi.fn(), retrieve: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRaw: mocks.mounted } }));
vi.mock('@aichat/rag', async importOriginal => ({
  ...await importOriginal<typeof import('@aichat/rag')>(), retrieve: mocks.retrieve,
}));
import { retrieveContext } from '../src/lib/rag-context';

const hit = { documentId: 'doc', ordinal: 0, name: 'fact.txt', text: 'The answer is 42', distance: 0.1 };

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.mounted.mockReset().mockResolvedValue([{ kbId: 'kb' }]);
  mocks.retrieve.mockReset();
  // Resolve the lazy package import before advancing virtual time. Keep all
  // real exports, including A2's budget constant, rather than faking the budget.
  await import('@aichat/rag');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('keeps the outer deadline pending through 7999ms and degrades at 8000ms', async () => {
  mocks.retrieve.mockImplementation(() => new Promise(() => {}));
  const settled = vi.fn();
  const pending = retrieveContext('owner', 'conversation', 'query').then(snapshot => {
    settled(snapshot);
    return snapshot;
  });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(mocks.retrieve).toHaveBeenCalledWith('owner', 'conversation', 'query');
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ status: 'RAG_UNAVAILABLE', hits: [] });
  expect(vi.getTimerCount()).toBe(0);
});

it('returns READY with hits when slow embedding makes retrieval take 4000ms', async () => {
  mocks.retrieve.mockImplementation(() => new Promise(resolve => {
    setTimeout(() => resolve([hit]), 4_000);
  }));
  const pending = retrieveContext('owner', 'conversation', 'query');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.retrieve).toHaveBeenCalledWith('owner', 'conversation', 'query');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await pending).toEqual({ status: 'READY', hits: [hit] });
  expect(vi.getTimerCount()).toBe(0);
});
