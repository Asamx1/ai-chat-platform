import { afterEach, expect, it, vi } from 'vitest';
import { llmJsonArray } from '../src/llm-json';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([undefined, 8_000, 40])('bounds requests and body parsing by the six-second cap or remaining budget (%s)', async budget => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  vi.stubGlobal('fetch', fetchMock);
  const pending = llmJsonArray('question', budget);
  const rejected = expect(pending).rejects.toThrow('RAG_TIMEOUT');
  const timeout = Math.min(6_000, budget ?? 6_000);
  await vi.advanceTimersByTimeAsync(timeout - 1);
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
