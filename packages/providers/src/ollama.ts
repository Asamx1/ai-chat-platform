import type { Usage } from '@aichat/contracts';
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStreamEvent,
  StreamChatOptions,
} from './ports';

/** Overall hard deadline for a single streamChat call. */
const OVERALL_DEADLINE_MS = 240_000;

/** Never use `localhost` here: it may resolve to ::1 and hit a ghost empty instance. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaAdapterOptions {
  baseUrl?: string;
  model: string;
}

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaAdapterOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: false,
      parallelTools: false,
      jsonSchema: false,
      reasoningVisibility: false,
      usageStreaming: false, // usage arrives only in the final aggregated chunk
      cancel: true,
      vision: false,
      maxContext: 32_768,
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
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          keep_alive: '10m',
          options: {
            num_predict: opts?.maxTokens ?? 2048,
            temperature: opts?.temperature,
          },
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

    if (!response.ok || !response.body) {
      yield { type: 'error', error: `ollama HTTP ${response.status}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const finish = async function* (
      reason: string,
    ): AsyncGenerator<ProviderStreamEvent> {
      try {
        await reader.cancel();
      } catch {
        // ignore cancellation failures on teardown
      }
      yield { type: 'done', finishReason: reason };
    };

    try {
      while (true) {
        if (signal?.aborted) {
          yield* finish('cancelled');
          return;
        }
        if (Date.now() > deadline) {
          yield { type: 'error', error: `ollama stream exceeded ${OVERALL_DEADLINE_MS / 1000}s deadline` };
          yield* finish('deadline');
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            const event = this.parseLine(line);
            if (event) yield event;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
      const tail = buffer.trim();
      if (tail.length > 0) {
        const event = this.parseLine(tail);
        if (event) yield event;
      }
      if (signal?.aborted) {
        yield* finish('cancelled');
        return;
      }
      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      if (signal?.aborted) {
        yield* finish('cancelled');
        return;
      }
      yield { type: 'error', error: describeError(err) };
      return;
    }
  }

  private parseLine(line: string): ProviderStreamEvent | undefined {
    let chunk: OllamaChatChunk;
    try {
      chunk = JSON.parse(line) as OllamaChatChunk;
    } catch {
      return undefined;
    }
    const content = chunk.message?.content;
    if (content && content.length > 0) {
      return { type: 'text-delta', delta: content };
    }
    if (chunk.done) {
      const usage: Usage = {
        promptTokens: chunk.prompt_eval_count ?? 0,
        completionTokens: chunk.eval_count ?? 0,
        costMicros: 0n,
        model: this.model,
        providerKey: 'ollama',
      };
      return { type: 'usage', usage };
    }
    return undefined;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
