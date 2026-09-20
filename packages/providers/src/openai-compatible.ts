import type { Usage } from '@aichat/contracts';
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStreamEvent,
  StreamChatOptions,
} from './ports';

const OVERALL_DEADLINE_MS = 240_000;

export interface Pricing {
  /** USD per 1M prompt tokens. */
  promptMicrosPerMillion?: number;
  /** USD per 1M completion tokens. */
  completionMicrosPerMillion?: number;
}

export interface OpenAICompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  pricing?: Pricing | undefined;
  /** Registry provider identifier for usage accounting. */
  providerKey?: string;
}

interface OpenAISSEChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly providerKey: string;
  private readonly pricing: Pricing | undefined;

  constructor(opts: OpenAICompatibleAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.providerKey = opts.providerKey ?? 'openai-compatible';
    this.pricing = opts.pricing;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: false,
      parallelTools: false,
      jsonSchema: false,
      reasoningVisibility: false,
      usageStreaming: true,
      cancel: true,
      vision: false,
      maxContext: 128_000,
      maxOutput: 8_192,
    };
  }

  async *streamChat(
    messages: ChatMessage[],
    opts?: StreamChatOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    const signal = opts?.signal;
    const deadline = Date.now() + OVERALL_DEADLINE_MS;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: opts?.maxTokens,
          temperature: opts?.temperature,
        }),
        signal: signal ?? null,
      });
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'done', finishReason: 'cancelled' };
        return;
      }
      yield { type: 'error', error: describeError(err) };
      return;
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        // ignore body read failure
      }
      yield { type: 'error', error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: 'empty response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      let finished = false;
      while (!finished) {
        if (signal?.aborted) {
          yield { type: 'done', finishReason: 'cancelled' };
          await reader.cancel().catch(() => {});
          return;
        }
        if (Date.now() > deadline) {
          yield {
            type: 'error',
            error: `openai-compatible stream exceeded ${OVERALL_DEADLINE_MS / 1000}s deadline`,
          };
          await reader.cancel().catch(() => {});
          yield { type: 'done', finishReason: 'deadline' };
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              finished = true;
              break;
            }
            if (payload.length > 0) {
              const event = this.parseChunk(payload);
              if (event) yield event;
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
      if (signal?.aborted) {
        yield { type: 'done', finishReason: 'cancelled' };
        await reader.cancel().catch(() => {});
        return;
      }
      if (!finished) {
        // stream ended without [DONE]; ensure done semantics if usage never seen
      }
      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'done', finishReason: 'cancelled' };
        return;
      }
      yield { type: 'error', error: describeError(err) };
      return;
    }
  }

  private parseChunk(payload: string): ProviderStreamEvent | undefined {
    let chunk: OpenAISSEChunk;
    try {
      chunk = JSON.parse(payload) as OpenAISSEChunk;
    } catch {
      return undefined;
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      return { type: 'text-delta', delta: content };
    }
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0;
      const completionTokens = chunk.usage.completion_tokens ?? 0;
      return { type: 'usage', usage: this.usage(promptTokens, completionTokens) };
    }
    return undefined;
  }

  private usage(promptTokens: number, completionTokens: number): Usage {
    const promptRate = this.pricing?.promptMicrosPerMillion; // USD per 1M prompt tokens → micros per token
    const completionRate = this.pricing?.completionMicrosPerMillion;
    let costMicros = 0n;
    if (promptRate !== undefined || completionRate !== undefined) {
      const p = promptRate ?? 0;
      const c = completionRate ?? 0;
      // cost in micro-USD = tokens * (USD per 1M tokens) * 1e6 / 1e6 = tokens * rate
      costMicros = BigInt(Math.round(promptTokens * p + completionTokens * c));
    }
    return {
      promptTokens,
      completionTokens,
      costMicros,
      model: this.model,
      providerKey: this.providerKey,
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
