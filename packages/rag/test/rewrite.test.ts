import { afterEach, expect, it, vi } from 'vitest';
import { rewriteQuery } from '../src/rewrite';

function mockContent(content: string) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content } })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['["first phrasing","second phrasing"]', 'Paraphrases: ```json\n["first phrasing","second phrasing"]\n```'])(
  'returns paraphrases from JSON: %s', async content => {
    const fetchMock = mockContent(content);
    expect(await rewriteQuery('question')).toEqual(['first phrasing', 'second phrasing']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({ model: 'qwen3:0.6b', format: 'json' });
  },
);

it('trims three paraphrases', async () => {
  mockContent('[" first ","second","third"]');
  expect(await rewriteQuery('question')).toEqual(['first', 'second', 'third']);
});

it.each(['garbage', '["unfinished', '[]', '["only one"]', '[1,2]', '["ok"," "]', '["same","same"]', '["a","b","c","d"]'])(
  'returns only the original query on invalid output: %s', async content => {
    const fetchMock = mockContent(content);
    expect(await rewriteQuery('question')).toEqual(['question']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it('falls back on a malformed response envelope and network failure', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not JSON'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: {} })))
    .mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  for (let i = 0; i < 3; i++) expect(await rewriteQuery('question')).toEqual(['question']);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('bounds response-body parsing by the caller budget and aborts', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  vi.stubGlobal('fetch', fetchMock);
  const pending = rewriteQuery('question', 800);
  await vi.advanceTimersByTimeAsync(800);
  expect(await pending).toEqual(['question']);
  expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
