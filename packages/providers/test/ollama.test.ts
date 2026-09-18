import { describe, expect, it } from 'vitest';
import type { ProviderStreamEvent } from '../src/index.js';
import { OllamaProvider } from '../src/index.js';

async function collect(iter: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

const MODEL = 'qwen3:0.6b';
const messages = [{ role: 'user' as const, content: 'Say hi in exactly three words.' }];

describe('OllamaProvider (live, 127.0.0.1:11434)', () => {
  it(
    'streams a full response ending with usage then done',
    async () => {
      const provider = new OllamaProvider({ model: MODEL });
      const events = await collect(provider.streamChat(messages, { maxTokens: 512 }));

      const last = events.at(-1);
      const secondLast = events.at(-2);
      expect(secondLast?.type).toBe('usage');
      expect(last).toEqual({ type: 'done', finishReason: 'stop' });

      if (secondLast?.type === 'usage') {
        expect(secondLast.usage.completionTokens).toBeGreaterThan(0);
        expect(secondLast.usage.promptTokens).toBeGreaterThan(0);
        expect(secondLast.usage.costMicros).toBe(0n);
        expect(secondLast.usage.model).toBe(MODEL);
        expect(secondLast.usage.providerKey).toBe('ollama');
      }
    },
    120_000,
  );

  it(
    'terminates cleanly on abort without throwing',
    async () => {
      const provider = new OllamaProvider({ model: MODEL });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);

      const events: ProviderStreamEvent[] = [];
      // Must not throw even if the underlying fetch rejects mid-stream.
      for await (const e of provider.streamChat(messages, { signal: ac.signal, maxTokens: 64 })) {
        events.push(e);
      }
      const last = events.at(-1);
      const ok =
        last?.type === 'done' &&
        (last.finishReason === 'cancelled' || last.finishReason === 'stop');
      expect(ok).toBe(true);
    },
    120_000,
  );
});
