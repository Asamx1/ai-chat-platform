import { describe, expect, it } from 'vitest';
import { RunEventEnvelopeSchema } from '@aichat/contracts';
import { FakeProvider } from '../src/index.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

const messages = [{ role: 'user' as const, content: 'hello world' }];

describe('FakeProvider', () => {
  it('streams scripted responses in order as text-delta and ends with done', async () => {
    const p = new FakeProvider(['first response', 'second response', 'third response']);
    const r1 = await collect(p.streamChat(messages));
    const r2 = await collect(p.streamChat(messages));
    const r3 = await collect(p.streamChat(messages));

    const texts = (es: typeof r1) =>
      es.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');
    expect(texts(r1)).toBe('first response');
    expect(texts(r2)).toBe('second response');
    expect(texts(r3)).toBe('third response');
    expect(r1.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('emits a usage event with char-based prompt estimate, token count and zero cost', async () => {
    const p = new FakeProvider(['one two three four']);
    const events = await collect(p.streamChat(messages)); // prompt = "hello world" = 11 chars
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    if (usage?.type === 'usage') {
      expect(usage.usage.promptTokens).toBe(11);
      expect(usage.usage.completionTokens).toBe(4);
      expect(usage.usage.costMicros).toBe(0n);
    }
  });

  it('stops streaming on abort and finishes with finishReason=cancelled', async () => {
    const p = new FakeProvider(['a a a a a a a a a a a a a a a a a a a a'], {
      perTokenDelayMs: 5,
    });
    const ac = new AbortController();
    const events: unknown[] = [];
    for await (const e of p.streamChat(messages, { signal: ac.signal })) {
      events.push(e);
      if (events.length === 3) ac.abort();
    }
    const last = events.at(-1);
    expect(last).toEqual({ type: 'done', finishReason: 'cancelled' });
    const deltas = events.filter((e) => (e as { type: string }).type === 'text-delta');
    expect(deltas.length).toBeLessThan(20);
  });

  it('validates a provider.delta RunEvent envelope sample against the contracts schema', async () => {
    const p = new FakeProvider(['sample text']);
    const events = await collect(p.streamChat(messages));
    const deltas = events.filter((e) => e.type === 'text-delta') as { delta: string }[];
    const envelope = {
      runId: 'run_123',
      seq: 3,
      type: 'provider.delta',
      time: new Date().toISOString(),
      participantId: 'seat-1',
      round: 1,
      payload: { delta: deltas[0]?.delta ?? '' },
    };
    const parsed = RunEventEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });
});
