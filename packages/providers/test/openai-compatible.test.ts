import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStreamEvent } from '../src/index.js';
import { OpenAICompatibleProvider } from '../src/index.js';
import type { Pricing } from '../src/index.js';

async function collect(iter: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** Build a fake fetch Response whose body streams the given SSE text. */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const messages = [{ role: 'user' as const, content: 'hello world' }];

function makeProvider(pricing?: Pricing) {
  return new OpenAICompatibleProvider({
    baseUrl: 'http://fake.local/v1',
    apiKey: 'test-key',
    model: 'test-model',
    pricing,
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OpenAICompatibleProvider', () => {
  it('emits text-deltas then usage then done from an SSE stream', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"lo!"}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchMock = vi.fn(async () => sseResponse(sse));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = await collect(makeProvider().streamChat(messages));

    const deltas = events.filter((e) => e.type === 'text-delta');
    expect(deltas.map((e) => (e as { delta: string }).delta).join('')).toBe('Hello!');
    expect(events.at(-2)?.type).toBe('usage');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    if (usage?.type === 'usage') {
      expect(usage.usage.promptTokens).toBe(100);
      expect(usage.usage.completionTokens).toBe(50);
      expect(usage.usage.costMicros).toBe(0n); // no pricing configured
      expect(usage.usage.providerKey).toBe('openai-compatible');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://fake.local/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe('test-model');
  });

  it('emits an error event when fetch rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const events = await collect(makeProvider().streamChat(messages));
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect((errorEvents[0] as { error: string }).error).toContain('network down');
  });

  it('emits an error event on HTTP 429', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    const events = await collect(makeProvider().streamChat(messages));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect((events.find((e) => e.type === 'error') as { error: string }).error).toContain('429');
  });

  it('computes costMicros from per-million-token pricing', async () => {
    // prompt 100 tokens @ $0.5/1M → 100 * 0.5 = 50 micro-USD
    // completion 50 tokens @ $0.5/1M → 50 * 0.5 = 25 micro-USD
    // total = 75 micro-USD = 75n
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    globalThis.fetch = vi.fn(async () => sseResponse(sse)) as unknown as typeof fetch;

    const provider = makeProvider({
      promptMicrosPerMillion: 0.5,
      completionMicrosPerMillion: 0.5,
    });
    const events = await collect(provider.streamChat(messages));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    if (usage?.type === 'usage') {
      // costMicros = (100*0.5 + 50*0.5) * 1e6 / 1e6 = 75
      expect(usage.usage.costMicros).toBe(75n);
    }
  });
});
