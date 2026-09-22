import { afterEach, expect, it, vi } from 'vitest';
import { rerank } from '../src/rerank';
import type { Candidate } from '../src/retrieve';

const hits: Candidate[] = ['a', 'b', 'c'].map((text, ordinal) => ({
  chunkId: text, documentId: 'doc', ordinal, name: 'doc', text: text.repeat(400),
  distance: ordinal / 10, parentId: null, kind: 'STANDALONE', embedding: '[]',
}));
function mockContent(content: string) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content } })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each(['[3,1,2]', 'Here is the order: ```json\n[3,1,2]\n```'])('reorders valid JSON: %s', async content => {
  vi.stubEnv('OLLAMA_BASE_URL', 'http://ollama.test:11434/');
  const fetchMock = mockContent(content);
  expect(await rerank('question', hits)).toEqual([hits[2], hits[0], hits[1]]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('http://ollama.test:11434/api/chat');
  const body = JSON.parse(init.body as string);
  expect(body).toMatchObject({ model: 'qwen3:0.6b', format: 'json', stream: false });
  expect(body.messages[1].content).toContain('a'.repeat(300));
  expect(body.messages[1].content).not.toContain('a'.repeat(301));
});

it.each(['garbage', '[3,', '[1,1,2]', '[0,1,2]', '[1,2,4]', '[1,2]', '[]', '["3",1,2]', '[1.5,2,3]'])(
  'preserves input on invalid output: %s', async content => {
    const fetchMock = mockContent(content);
    expect(await rerank('question', hits)).toBe(hits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it('falls back on HTTP and network errors without retrying', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  expect(await rerank('question', hits)).toBe(hits);
  expect(await rerank('question', hits)).toBe(hits);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('aborts within budget and falls back even when fetch ignores abort', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetchMock);
  const pending = rerank('question', hits);
  await vi.advanceTimersByTimeAsync(2_900);
  expect(await pending).toBe(hits);
  expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not call Ollama for fewer than two candidates', async () => {
  const fetchMock = mockContent('[]');
  expect(await rerank('question', [])).toEqual([]);
  expect(await rerank('question', hits.slice(0, 1))).toEqual(hits.slice(0, 1));
  expect(fetchMock).not.toHaveBeenCalled();
});
