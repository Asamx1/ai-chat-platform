import { afterEach, expect, it, vi } from 'vitest';
import { quotaProvider } from '../src/quota-provider';
import type { RegistryModel, ResolvedModel } from '../src/resolver';
import type { QuotaCall } from '../src/quota';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ['deepseek-chat', null],
  ['deepseek-reasoner', null],
  ['deepseek-chat', 'deepseek'],
  ['deepseek-reasoner', 'deepseek'],
] as const)('keeps %s in the cloud with adapter %s and available quota', async (model, adapter) => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://deepseek.test/v1');
  const row: RegistryModel = {
    id: 'cloud-id', modelKey: model, providerId: 'deepseek', kind: 'cloud',
    adapter, baseUrl: null, isDefault: false,
    provider: { kind: 'deepseek', baseUrl: 'https://deepseek.test/v1' },
  };
  let call: QuotaCall | undefined;
  const db = {
    modelRegistry: { findUnique: vi.fn(async () => row), findFirst: vi.fn(async () => null) },
    apiKey: { findUnique: vi.fn(async () => null) },
    userModelQuota: { findUnique: vi.fn(async () => ({ dailyLimit: 200_000 })) },
    modelUsageDaily: {
      findUnique: vi.fn(async () => ({ tokensIn: 100, tokensOut: 50, reservedTokens: 0 })),
      upsert: vi.fn(async () => ({})),
    },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "ProviderCall"')) return call ? [call] : [];
      if (sql.includes('FROM "ModelUsageDaily"')) return [{ tokensIn: 100, tokensOut: 50, reservedTokens: 0 }];
      if (sql.includes('FROM "UserModelQuota"')) return [{ dailyLimit: 200_000 }];
      throw new Error(`Unexpected query: ${sql}`);
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.startsWith('INSERT INTO "ProviderCall"')) {
        call = { id: values[0] as string, quotaReservation: JSON.parse(values[4] as string) };
      }
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  const fetchMock = vi.fn(async () => new Response(
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    + 'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n',
  ));
  vi.stubGlobal('fetch', fetchMock);
  const onResolved = vi.fn(async (_resolved: ResolvedModel) => {});
  const provider = quotaProvider(db as unknown as Parameters<typeof quotaProvider>[0], {
    userId: 'user', runId: 'run', modelId: row.id, attempt: 0, seatId: 'default', invocation: 0, onResolved,
  });
  const events = [];
  for await (const event of provider.streamChat([{ role: 'user', content: 'hello' }], { maxTokens: 100 })) events.push(event);

  expect(db.modelRegistry.findFirst).not.toHaveBeenCalled();
  expect(onResolved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    modelId: row.id, model, kind: 'cloud', adapter: adapter ?? 'openai-compatible',
  }));
  expect(onResolved.mock.calls[0]?.[0].degraded).toBeUndefined();
  expect(call?.quotaReservation).toMatchObject({ modelId: row.id, amount: 621 });
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://deepseek.test/v1/chat/completions', expect.objectContaining({
    body: expect.stringContaining(`"model":"${model}"`),
  }));
  expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('SET "quotaReservation"=$2'), expect.any(String),
    expect.stringContaining('"state":"settled"'), expect.any(String),
  );
  expect(events).toContainEqual({ type: 'text-delta', delta: 'hello' });
  expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
});
