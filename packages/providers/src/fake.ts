import type { Usage } from '@aichat/contracts';
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStreamEvent,
  StreamChatOptions,
} from './ports';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Split text into deterministic "tokens" (words + whitespace runs kept verbatim). */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

export class FakeProvider implements ProviderAdapter {
  private readonly script: readonly string[];
  private readonly perTokenDelayMs: number;
  private callIndex = 0;

  constructor(script: readonly string[], opts?: { perTokenDelayMs?: number }) {
    if (script.length === 0) throw new Error('FakeProvider requires a non-empty script');
    this.script = script;
    this.perTokenDelayMs = opts?.perTokenDelayMs ?? 0;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: false,
      parallelTools: false,
      jsonSchema: false,
      reasoningVisibility: false,
      usageStreaming: false,
      cancel: true,
      vision: false,
      maxContext: 8192,
      maxOutput: 2048,
    };
  }

  async *streamChat(
    messages: ChatMessage[],
    opts?: StreamChatOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const signal = opts?.signal;
    const response = this.script[this.callIndex % this.script.length] ?? '';
    this.callIndex += 1;

    const promptTokens = messages.reduce((n, m) => n + m.content.length, 0);
    const tokens = tokenize(response);
    let completionTokens = 0;

    for (const token of tokens) {
      if (signal?.aborted) {
        yield { type: 'usage', usage: this.usage(promptTokens, completionTokens) };
        yield { type: 'done', finishReason: 'cancelled' };
        return;
      }
      if (this.perTokenDelayMs > 0) await sleep(this.perTokenDelayMs);
      if (signal?.aborted) {
        yield { type: 'usage', usage: this.usage(promptTokens, completionTokens) };
        yield { type: 'done', finishReason: 'cancelled' };
        return;
      }
      completionTokens += 1;
      yield { type: 'text-delta', delta: token };
    }

    yield { type: 'usage', usage: this.usage(promptTokens, completionTokens) };
    yield { type: 'done', finishReason: 'stop' };
  }

  private usage(promptTokens: number, completionTokens: number): Usage {
    return {
      promptTokens,
      completionTokens,
      costMicros: 0n,
      model: 'fake-model',
      providerKey: 'fake',
    };
  }
}
