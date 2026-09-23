import { beforeEach, expect, it, vi } from 'vitest';
import type { ResolvedModel } from '../src/resolver';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), fallback: vi.fn(), findQuotaCall: vi.fn(), reserveQuota: vi.fn(), finishQuota: vi.fn(),
}));
vi.mock('../src/resolver', () => ({ createResolver: () => ({ resolve: mocks.resolve, fallback: mocks.fallback }) }));
vi.mock('../src/quota', () => mocks);
vi.mock('../src/ollama', () => ({
  OllamaProvider: class {
    capabilities() { return { maxOutput: 100 }; }
    async *streamChat() {
      yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 2 } };
      yield { type: 'done', finishReason: 'stop' };
    }
  },
}));
import { quotaProvider } from '../src/quota-provider';

const initial: ResolvedModel = {
  modelId: 'local-id', model: 'local', provider: 'ollama', adapter: 'ollama', kind: 'local',
  baseUrl: 'http://localhost:11434', apiKey: '', keySource: null,
  degraded: { reason: 'NO_KEY', from: 'cloud' },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findQuotaCall.mockResolvedValue(null);
  mocks.reserveQuota.mockResolvedValue({ id: 'call' });
  mocks.resolve.mockResolvedValue(initial);
});

it.each([true, false])('reuseInitial=%s preserves one degradation callback and quota accounting', async reuseInitial => {
  const onResolved = vi.fn(async () => {});
  const provider = quotaProvider({} as Parameters<typeof quotaProvider>[0], {
    userId: 'user', runId: 'run', modelId: 'cloud', attempt: 0, seatId: 'default', invocation: 0,
    initial, reuseInitial, onResolved,
  });
  for await (const _event of provider.streamChat([{ role: 'user', content: 'hello' }])) { /* drain */ }
  expect(mocks.resolve).toHaveBeenCalledTimes(reuseInitial ? 0 : 1);
  expect(onResolved).toHaveBeenCalledExactlyOnceWith(initial);
  expect(mocks.reserveQuota).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ modelId: 'local-id', cloud: false }));
  expect(mocks.finishQuota).toHaveBeenCalledOnce();
});
