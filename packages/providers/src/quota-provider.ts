import { createResolver, type ResolverStore, type ResolvedModel } from './resolver';
import { findQuotaCall, reserveQuota, finishQuota, type QuotaStore } from './quota';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { ProviderAdapter, ChatMessage, StreamChatOptions, ProviderStreamEvent } from './ports';

/** All production execution paths use this entry. Queue-time resolve is only a precheck. */
export function quotaProvider(db: ResolverStore & QuotaStore, input: {
  userId: string; runId: string; modelId: string; attempt: number; seatId: string; invocation: number;
  initial?: ResolvedModel | undefined;
  onResolved?: (model: ResolvedModel) => Promise<void>;
}): ProviderAdapter {
  const resolver = createResolver(db);
  const requestHash = JSON.stringify(['quota-v1', input.runId, input.seatId, input.invocation]);
  const build = (r: ResolvedModel): ProviderAdapter => r.adapter === 'ollama'
    ? new OllamaProvider({ baseUrl: r.baseUrl, model: r.model })
    : new OpenAICompatibleProvider({ baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model });
  return {
    capabilities: () => (input.initial ? build(input.initial) : new OpenAICompatibleProvider({ baseUrl: '', apiKey: '', model: '' })).capabilities(),
    async *streamChat(messages: ChatMessage[], opts?: StreamChatOptions): AsyncIterable<ProviderStreamEvent> {
      const previous = await findQuotaCall(db, requestHash);
      if (previous) {
        const r = previous.quotaReservation;
        if (!r || r.state !== 'settled') throw new Error('QUOTA_OUTCOME_UNKNOWN');
        yield { type: 'text-delta', delta: r.text ?? '' };
        yield { type: 'usage', usage: { promptTokens: r.tokensIn!, completionTokens: r.tokensOut!, costMicros: 0n, model: r.modelId, providerKey: 'replay' } };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      let resolved = await resolver.resolve(input.userId, input.modelId);
      let provider = build(resolved);
      let maxTokens = Math.min(opts?.maxTokens ?? provider.capabilities().maxOutput, provider.capabilities().maxOutput);
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('INVALID_MAX_TOKENS');
      // An arbitrary OpenAI-compatible endpoint does not imply a supported tokenizer.
      const bound = resolved.adapter === 'openai-compatible' && resolved.provider === 'deepseek'
        ? provider.inputTokenUpperBound?.(messages) : undefined;
      if (resolved.kind === 'cloud' && bound === undefined) {
        resolved = await resolver.fallback(input.modelId, 'QUOTA_EXCEEDED');
        provider = build(resolved);
      }
      let call = await reserveQuota(db, { ...input, modelId: resolved.modelId, requestHash,
        amount: resolved.kind === 'cloud' ? bound! + maxTokens : 0, cloud: resolved.kind === 'cloud' });
      if (!call) {
        resolved = await resolver.fallback(input.modelId, 'QUOTA_EXCEEDED');
        provider = build(resolved);
        call = await reserveQuota(db, { ...input, modelId: resolved.modelId, requestHash, amount: 0, cloud: false });
      }
      if (!call) throw new Error('QUOTA_RESERVATION_FAILED');
      maxTokens = Math.min(maxTokens, provider.capabilities().maxOutput);
      try {
        await input.onResolved?.(resolved);
        if (opts?.signal?.aborted) throw new Error('ABORTED_BEFORE_SEND');
      } catch (error) {
        await finishQuota(db, call, 'not-sent');
        throw error;
      }
      let text = '', usage: { tokensIn: number; tokensOut: number } | undefined;
      let completed = false;
      // Once iterator execution starts, errors/abort/crashes are unknown: never refund or resend.
      for await (const event of provider.streamChat(messages, { ...opts, maxTokens })) {
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'text-delta') text += event.delta;
        if (event.type === 'usage') usage = { tokensIn: event.usage.promptTokens, tokensOut: event.usage.completionTokens };
        if (event.type === 'done') {
          completed = event.finishReason === 'stop' || event.finishReason === 'length';
          continue;
        }
        yield event;
      }
      if (!completed || !usage || opts?.signal?.aborted) throw new Error('QUOTA_OUTCOME_UNKNOWN');
      await finishQuota(db, call, { ...usage, text });
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}
