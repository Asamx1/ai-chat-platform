import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResolver, type RegistryModel, type ResolvedModel, type ResolverStore } from '../src/resolver';
import { quotaProvider } from '../src/quota-provider';
import { OpenAICompatibleProvider } from '../src/openai-compatible';
import type { QuotaStore } from '../src/quota';
import type { ChatMessage, ProviderStreamEvent } from '../src/ports';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(), findQuotaCall: vi.fn(), reserveQuota: vi.fn(), finishQuota: vi.fn(),
}));
vi.mock('@aichat/crypto', () => ({ decrypt: mocks.decrypt }));
// Keep resolution and both adapters real; quota persistence is covered separately.
vi.mock('../src/quota', () => ({
  findQuotaCall: mocks.findQuotaCall,
  reserveQuota: mocks.reserveQuota,
  finishQuota: mocks.finishQuota,
}));

const cloud: RegistryModel = {
  id: 'registry-deepseek-chat', modelKey: 'deepseek-chat', providerId: 'deepseek',
  kind: 'cloud', adapter: null, baseUrl: null, isDefault: false,
  provider: { kind: 'deepseek', baseUrl: 'https://deepseek.example/v1' },
};
const local: RegistryModel = {
  id: 'registry-local', modelKey: 'qwen3:0.6b', providerId: 'ollama',
  kind: 'local', adapter: null, baseUrl: null, isDefault: true,
  provider: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
};
const messages: ChatMessage[] = [{ role: 'user', content: '你好，hello' }];
const dailyLimit = 200_000;

function fakeStore(tokens = 30) {
  const db = {
    modelRegistry: {
      findUnique: vi.fn(async ({ where }: Parameters<ResolverStore['modelRegistry']['findUnique']>[0]) =>
        where.id === cloud.id ? cloud : where.id === local.id ? local : null),
      findFirst: vi.fn(async () => local),
    },
    apiKey: { findUnique: vi.fn(async () => ({ ciphertext: 'encrypted-key' })) },
    userModelQuota: { findUnique: vi.fn(async () => ({ dailyLimit })) },
    modelUsageDaily: {
      findUnique: vi.fn(async () => ({ tokensIn: tokens - 10, tokensOut: 10, reservedTokens: 0 })),
      upsert: vi.fn(async () => ({})),
    },
    // SQL must not be reached through the mocked persistence boundary.
    async $queryRawUnsafe(): Promise<never> { throw new Error('Unexpected SQL query'); },
    async $executeRawUnsafe(): Promise<never> { throw new Error('Unexpected SQL write'); },
    async $transaction(): Promise<never> { throw new Error('Unexpected SQL transaction'); },
  } satisfies ResolverStore & QuotaStore;
  return db;
}

function mockTransport() {
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (url === `${cloud.provider.baseUrl}/chat/completions`) {
      return new Response([
        'data: {"choices":[{"delta":{"content":"cloud reply"}}]}',
        'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}',
        'data: [DONE]', '',
      ].join('\n'));
    }
    if (url === `${local.provider.baseUrl}/api/chat`) {
      return new Response([
        JSON.stringify({ message: { content: 'local reply' }, done: false }),
        JSON.stringify({ done: true, prompt_eval_count: 2, eval_count: 3 }), '',
      ].join('\n'));
    }
    throw new Error(`Unexpected provider URL: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function stream(db: ReturnType<typeof fakeStore>) {
  const onResolved = vi.fn(async (_model: ResolvedModel) => {});
  const provider = quotaProvider(db, {
    userId: 'user', runId: 'run', modelId: cloud.id,
    attempt: 0, seatId: 'default', invocation: 0, onResolved,
  });
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.streamChat(messages, { maxTokens: 32 })) events.push(event);
  return { events, onResolved };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.decrypt.mockReturnValue('db-secret');
  mocks.findQuotaCall.mockResolvedValue(undefined);
  mocks.reserveQuota.mockResolvedValue({ id: 'call' });
  mocks.finishQuota.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek quota degradation regressions', () => {
  it('normalizes Provider kind deepseek to the openai-compatible adapter', async () => {
    const db = fakeStore();
    const resolved = await createResolver(db, { env: {}, decrypt: mocks.decrypt }).resolve('user', cloud.id);
    expect(mocks.decrypt).toHaveBeenCalledExactlyOnceWith('encrypted-key');
    expect(resolved).toMatchObject({ kind: 'cloud', provider: 'deepseek', keySource: 'db' });
    expect(resolved.adapter).toBe('openai-compatible');
  });

  it('streams deepseek-chat through OpenAICompatibleProvider while below quota', async () => {
    const db = fakeStore();
    const fetchMock = mockTransport();
    const { events, onResolved } = await stream(db);
    expect(mocks.decrypt).toHaveBeenCalledExactlyOnceWith('encrypted-key');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${cloud.provider.baseUrl}/chat/completions`, expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer db-secret' }),
        body: expect.stringContaining('"model":"deepseek-chat"'),
      }),
    );
    expect(db.modelRegistry.findFirst).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelId: cloud.id, kind: 'cloud' }));
    expect(onResolved.mock.calls[0]?.[0]).not.toHaveProperty('degraded');
    const bound = new OpenAICompatibleProvider({ baseUrl: '', apiKey: '', model: cloud.modelKey }).inputTokenUpperBound(messages)!;
    expect(mocks.reserveQuota).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({
      modelId: cloud.id, cloud: true, amount: bound + 32,
    }));
    expect(events).toContainEqual({ type: 'text-delta', delta: 'cloud reply' });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(mocks.finishQuota).toHaveBeenCalledExactlyOnceWith(db, { id: 'call' }, {
      tokensIn: 2, tokensOut: 3, text: 'cloud reply',
    });
  });

  it('provides a positive input token upper bound for deepseek-reasoner', () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: cloud.provider.baseUrl, apiKey: 'db-secret', model: 'deepseek-reasoner',
    });
    expect(provider.inputTokenUpperBound(messages)).toBeGreaterThan(0);
  });

  it('preserves the ollama adapter for local registry rows', async () => {
    const db = fakeStore();
    expect(await createResolver(db, { env: {} }).resolve('user', local.id)).toMatchObject({
      adapter: 'ollama', kind: 'local', model: local.modelKey, keySource: null,
    });
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
    expect(db.modelUsageDaily.findUnique).not.toHaveBeenCalled();
  });

  it.each([dailyLimit, dailyLimit + 1])('still falls back to ollama when usage is %s', async tokens => {
    const db = fakeStore(tokens);
    const fetchMock = mockTransport();
    const { events, onResolved } = await stream(db);
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: local.id, adapter: 'ollama', kind: 'local',
      degraded: { reason: 'QUOTA_EXCEEDED', from: cloud.id },
    }));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${local.provider.baseUrl}/api/chat`, expect.objectContaining({
        body: expect.stringContaining(`"model":"${local.modelKey}"`),
      }),
    );
    expect(mocks.reserveQuota).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({
      modelId: local.id, cloud: false, amount: 0,
    }));
    expect(events).toContainEqual({ type: 'text-delta', delta: 'local reply' });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(mocks.finishQuota).toHaveBeenCalledExactlyOnceWith(db, { id: 'call' }, {
      tokensIn: 2, tokensOut: 3, text: 'local reply',
    });
  });
});
