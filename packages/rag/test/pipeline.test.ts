import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunk } from '../src/chunk';
import { parse, PermanentRagError } from '../src/parse';
import { embed } from '../src/embed';

const vector = () => Array.from({ length: 1024 }, () => 0.1);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('chunk', () => {
  it('handles empty, whitespace, exact boundary and overlap', () => {
    expect(chunk([])).toEqual([]);
    expect(chunk([{ text: ' \n' }])).toEqual([]);
    expect(chunk([{ text: 'a'.repeat(512) }])).toHaveLength(1);
    const text = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x10000 + i)).join('');
    const slices = chunk([{ text }]);
    expect(slices.map(s => [s.ordinal, s.start, s.end])).toEqual([[0, 0, 512], [1, 462, 974], [2, 924, 1000]]);
    expect(Array.from(slices[0]!.text).slice(-50)).toEqual(Array.from(slices[1]!.text).slice(0, 50));
    for (const s of slices) expect(s.text).toBe(Array.from(text).slice(s.start, s.end).join(''));
  });
  it('normalizes offsets and rejects invalid windows', () => {
    expect(chunk([{ text: 'a\r\n\0😀' }, { text: 'b' }], 3, 1)).toEqual([
      { ordinal: 0, start: 0, end: 3, text: 'a\n😀' },
      { ordinal: 1, start: 2, end: 5, text: '😀\nb' },
    ]);
    expect(() => chunk([], 50, 50)).toThrow(RangeError);
  });
});
describe('parse', () => {
  it.each(['text/plain', 'text/markdown'])('decodes strict UTF-8: %s', async mime => {
    expect(await parse(new TextEncoder().encode('a\r\n\0😀'), mime)).toEqual([{ text: 'a\n😀' }]);
    await expect(parse(Uint8Array.of(0xff), mime)).rejects.toThrow('INVALID_UTF8');
    await expect(parse(new Uint8Array(), mime)).rejects.toThrow('EMPTY_TEXT');
  });
  it('uses the worker PDF parser and rejects scanned/invalid PDFs', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7');
    expect(await parse(bytes, 'application/pdf', async () => 'pdf text')).toEqual([{ text: 'pdf text' }]);
    await expect(parse(bytes, 'application/pdf', async () => '')).rejects.toThrow('SCANNED_PDF');
    await expect(parse(new Uint8Array(), 'application/pdf', async () => 'x')).rejects.toThrow('INVALID_PDF');
  });
});
describe('embed', () => {
  it('batches 64 sequentially using the Ollama protocol without waiting between batches', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EMBED_BATCH', '');
    vi.stubEnv('OLLAMA_NUM_PARALLEL', '');
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.truncate).toBe(false);
      expect(body.keep_alive).toBe('30m');
      expect(body.num_parallel).toBe(4);
      return Response.json({ embeddings: body.input.map(vector) });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await embed(Array(65).fill('text'), new AbortController().signal)).toHaveLength(65);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).input).toHaveLength(64);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).input).toHaveLength(1);
  });
  it.each([
    ['3', 3], ['1', 1], ['0', 64], ['-1', 64], ['1.5', 64],
    ['invalid', 64], ['Infinity', 64], ['9007199254740992', 64],
  ])('uses EMBED_BATCH=%s with a safe positive fallback', async (value, size) => {
    vi.stubEnv('EMBED_BATCH', value);
    vi.stubEnv('OLLAMA_NUM_PARALLEL', '2');
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.num_parallel).toBe(2);
      return Response.json({ embeddings: body.input.map((text: string) => Array(1024).fill(Number(text) + 1)) });
    });
    vi.stubGlobal('fetch', fetcher);
    const texts = Array.from({ length: 65 }, (_, i) => String(i));
    const vectors = await embed(texts, new AbortController().signal);
    expect(vectors.map(v => v[0])).toEqual(texts.map(text => Number(text) + 1));
    expect(fetcher).toHaveBeenCalledTimes(Math.ceil(65 / size));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).input).toHaveLength(size);
  });
  it.each(['0', '-1', '1.5', 'invalid', 'Infinity'])('defaults invalid OLLAMA_NUM_PARALLEL=%s', async value => {
    vi.stubEnv('OLLAMA_NUM_PARALLEL', value);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).num_parallel).toBe(4);
      return Response.json({ embeddings: [vector()] });
    }));
    await embed(['x'], new AbortController().signal);
  });
  it.each([400, 404, 408, 429, 500])('preserves HTTP error classification for %s', async status => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    const error = await embed(['x'], new AbortController().signal).catch(error => error);
    expect(error.message).toBe(`EMBED_HTTP_${status}`);
    expect(error instanceof PermanentRagError).toBe(status === 400 || status === 404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[], [1], Array(1024).fill(0), [...Array(1023).fill(1), null]])('rejects invalid vectors %#', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ embeddings: [value] })));
    await expect(embed(['x'], new AbortController().signal)).rejects.toBeInstanceOf(PermanentRagError);
  });
  it('rejects the wrong response count', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ embeddings: [] })));
    await expect(embed(['x'], new AbortController().signal)).rejects.toThrow('COUNT');
  });
  it('aborts after 60 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    })));
    const result = expect(embed(['x'], new AbortController().signal)).rejects.toThrow('EMBED_TIMEOUT');
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
  });
  it('leaves retry to the queue and succeeds on the next attempt', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(Response.json({ embeddings: [vector()] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(embed(['x'], new AbortController().signal)).rejects.toThrow('network');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await embed(['x'], new AbortController().signal)).toEqual([vector()]);
  });
});
