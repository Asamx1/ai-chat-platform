import { describe, expect, it, vi } from 'vitest';
import { createResolver, incrementDailyUsage, type RegistryModel, type ResolverStore } from '../src/resolver';

const cloud: RegistryModel = {
  id: 'registry-deepseek-id', modelKey: 'deepseek-chat', providerId: 'deepseek', kind: 'cloud',
  baseUrl: 'https://registry.example/v1', adapter: 'openai-compatible', isDefault: false,
  provider: { kind: 'openai-compatible', baseUrl: 'https://provider.example/v1' },
};
const local: RegistryModel = {
  ...cloud, id: 'local-id', modelKey: 'qwen3:0.6b', providerId: 'ollama', kind: 'local',
  baseUrl: null, adapter: null, isDefault: true,
  provider: { kind: 'ollama', baseUrl: 'http://localhost:11434' },
};
function setup(env: Record<string, string> = {}) {
  const db = {
    userModelQuota: { findUnique: vi.fn(async (): Promise<{ dailyLimit: number } | null> => null) },
    modelRegistry: { findUnique: vi.fn(async (): Promise<RegistryModel | null> => cloud), findFirst: vi.fn(async (): Promise<RegistryModel | null> => local) },
    apiKey: { findUnique: vi.fn(async (): Promise<{ ciphertext: string } | null> => null) },
    modelUsageDaily: {
      findUnique: vi.fn(async (_args: Parameters<ResolverStore['modelUsageDaily']['findUnique']>[0]): Promise<{ tokensIn: number; tokensOut: number } | null> => null),
      upsert: vi.fn(async () => ({})),
    },
  } satisfies ResolverStore;
  const decrypt = vi.fn(() => 'db-secret');
  const now = () => new Date('2026-09-20T23:59:59Z');
  return { db, decrypt, resolver: createResolver(db, { env, now, decrypt }) };
}

describe('provider resolver', () => {
  it.each(['deepseek', 'openai-compatible', 'other-cloud'])('normalizes an unset adapter for provider kind %s', async kind => {
    const { db, resolver } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.modelRegistry.findUnique.mockResolvedValue({ ...cloud, adapter: null, provider: { ...cloud.provider, kind } });
    expect(await resolver.resolve('u', cloud.id)).toMatchObject({ adapter: 'openai-compatible', provider: 'deepseek', kind: 'cloud' });
  });

  it('preserves an explicit adapter', async () => {
    const { db, resolver } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.modelRegistry.findUnique.mockResolvedValue({ ...cloud, adapter: 'custom-adapter', provider: { ...cloud.provider, kind: 'deepseek' } });
    expect((await resolver.resolve('u', cloud.id)).adapter).toBe('custom-adapter');
  });

  it('treats whitespace env keys as unavailable, matching the model list', async () => {
    const { resolver } = setup({ DEEPSEEK_API_KEY: '  ' });
    expect(await resolver.resolve('u', cloud.id)).toMatchObject({ degraded: { reason: 'NO_KEY' } });
  });

  it('prefers the user DB key and Registry URL over env', async () => {
    const { db, decrypt, resolver } = setup({ DEEPSEEK_API_KEY: 'env-secret' });
    db.apiKey.findUnique.mockResolvedValue({ ciphertext: 'encrypted' });
    expect(await resolver.resolve('user-a', cloud.id)).toMatchObject({ apiKey: 'db-secret', keySource: 'db', baseUrl: cloud.baseUrl });
    expect(decrypt).toHaveBeenCalledWith('encrypted');
    expect(db.apiKey.findUnique).toHaveBeenCalledWith({ where: { userId_provider: { userId: 'user-a', provider: 'deepseek' } } });
  });
  it.each([undefined, 'https://proxy.example/v1'])('uses env key with base URL %s', async baseUrl => {
    const { resolver } = setup({ DEEPSEEK_API_KEY: 'env-secret', ...(baseUrl ? { DEEPSEEK_BASE_URL: baseUrl } : {}) });
    expect(await resolver.resolve('u', cloud.id)).toMatchObject({ keySource: 'env', apiKey: 'env-secret', baseUrl: baseUrl ?? 'https://api.deepseek.com/v1' });
  });
  it('falls back without querying quota when no key exists', async () => {
    const { resolver, db } = setup();
    expect(await resolver.resolve('u', cloud.id)).toMatchObject({ model: local.modelKey, apiKey: '', degraded: { reason: 'NO_KEY', from: cloud.id } });
    expect(db.modelUsageDaily.findUnique).not.toHaveBeenCalled();
  });
  it.each([200_000, 200_001])('checks summed usage at %s tokens', async tokens => {
    const { resolver, db } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.modelUsageDaily.findUnique.mockResolvedValue({ tokensIn: tokens - 10, tokensOut: 10 });
    const result = await resolver.resolve('u', cloud.id);
    expect(result.degraded).toEqual(tokens >= 200_000 ? { reason: 'QUOTA_EXCEEDED', from: cloud.id } : undefined);
    expect(db.modelUsageDaily.findUnique).toHaveBeenCalledWith({ where: { userId_modelId_date: { userId: 'u', modelId: cloud.id, date: new Date('2026-09-20T00:00:00Z') } } });
  });
  it.each([local, cloud])('resolves legacy modelKey $modelKey to the registry id', async row => {
    const { resolver, db } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.modelRegistry.findUnique.mockResolvedValue(null);
    db.modelRegistry.findFirst.mockResolvedValue(row);
    expect(await resolver.resolve('u', row.modelKey)).toMatchObject({ modelId: row.id, model: row.modelKey });
    expect(db.modelRegistry.findFirst).toHaveBeenCalledWith({
      where: { modelKey: row.modelKey, provider: { enabled: true } },
      include: { provider: true }, orderBy: { updatedAt: 'desc' },
    });
    if (row.kind === 'cloud') {
      expect(db.modelUsageDaily.findUnique).toHaveBeenCalledWith({ where: {
        userId_modelId_date: { userId: 'u', modelId: row.id, date: new Date('2026-09-20') },
      } });
    }
  });
  it('prefers an exact registry id over a colliding modelKey', async () => {
    const { resolver, db } = setup();
    db.modelRegistry.findUnique.mockResolvedValue(local);
    expect(await resolver.resolve('u', local.id)).toMatchObject({ modelId: local.id, model: local.modelKey });
    expect(db.modelRegistry.findFirst).not.toHaveBeenCalled();
  });
  it('reports unknown models as 400', async () => {
    const { resolver, db } = setup();
    db.modelRegistry.findUnique.mockResolvedValue(null);
    db.modelRegistry.findFirst.mockResolvedValue(null);
    await expect(resolver.resolve('u', 'unknown')).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_MODEL' });
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
  });
  it('resolves local models without credentials or quota', async () => {
    const { resolver, db } = setup();
    db.modelRegistry.findUnique.mockResolvedValue(local);
    expect(await resolver.resolve('u', local.id)).toMatchObject({ adapter: 'ollama', keySource: null, baseUrl: local.provider.baseUrl });
    expect(db.apiKey.findUnique).not.toHaveBeenCalled();
  });
  it('restricts configured fallback to local ollama', async () => {
    const { resolver, db } = setup({ LOCAL_DEFAULT_MODEL: 'qwen3:0.6b' });
    await resolver.resolve('u', cloud.id);
    expect(db.modelRegistry.findFirst).toHaveBeenCalledWith({ where: { kind: 'local', provider: { kind: 'ollama' }, modelKey: 'qwen3:0.6b' }, include: { provider: true }, orderBy: { id: 'asc' } });
    db.modelRegistry.findFirst.mockResolvedValue(null);
    await expect(resolver.resolve('u', cloud.id)).rejects.toMatchObject({ code: 'NO_LOCAL_MODEL', status: 503 });
  });
  it('does not hide decryption failures with an env key', async () => {
    const { resolver, db, decrypt } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.apiKey.findUnique.mockResolvedValue({ ciphertext: 'bad' });
    decrypt.mockImplementation(() => { throw new Error('decryption failed'); });
    await expect(resolver.resolve('u', cloud.id)).rejects.toThrow('decryption failed');
  });
  it('never sends the DeepSeek env key to another provider', async () => {
    const { resolver, db } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.modelRegistry.findUnique.mockResolvedValue({ ...cloud, providerId: 'other' });
    expect((await resolver.resolve('u', cloud.id)).degraded?.reason).toBe('NO_KEY');
  });
});

describe('daily usage write contract', () => {
  it('passes atomic increments to the supplied transaction, with UTC rollover', async () => {
    const { db } = setup();
    await incrementDailyUsage(db, 'u', cloud.id, 100, 20, new Date('2026-09-20T23:59:59Z'));
    await incrementDailyUsage(db, 'u', cloud.id, 7, 3, new Date('2026-09-21T00:00:00Z'));
    expect(db.modelUsageDaily.upsert).toHaveBeenNthCalledWith(1, {
      where: { userId_modelId_date: { userId: 'u', modelId: cloud.id, date: new Date('2026-09-20') } },
      create: { userId: 'u', modelId: cloud.id, date: new Date('2026-09-20'), tokensIn: 100, tokensOut: 20 },
      update: { tokensIn: { increment: 100 }, tokensOut: { increment: 20 } },
    });
    expect(db.modelUsageDaily.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      create: { userId: 'u', modelId: cloud.id, date: new Date('2026-09-21'), tokensIn: 7, tokensOut: 3 },
    }));
  });
  it('uses a fresh daily row after midnight', async () => {
    const { db } = setup();
    db.modelUsageDaily.findUnique.mockImplementation(async args => args.where.userId_modelId_date.date.toISOString().startsWith('2026-09-20') ? { tokensIn: 200_001, tokensOut: 0 } : null);
    let time = new Date('2026-09-20T23:59:59Z');
    const resolver = createResolver(db, { env: { DEEPSEEK_API_KEY: 'key' }, now: () => time });
    expect((await resolver.resolve('u', cloud.id)).degraded?.reason).toBe('QUOTA_EXCEEDED');
    time = new Date('2026-09-21T00:00:00Z');
    expect((await resolver.resolve('u', cloud.id)).degraded).toBeUndefined();
  });
  it.each([-1, 1.5, NaN])('rejects invalid usage %s before writing', async value => {
    const { db } = setup();
    await expect(incrementDailyUsage(db, 'u', cloud.id, value, 0)).rejects.toThrow(RangeError);
    expect(db.modelUsageDaily.upsert).not.toHaveBeenCalled();
  });
});

describe('per-user model quota overrides', () => {
  it.each([0, 50, 200000])('uses override %s including zero and exact limit', async dailyLimit => {
    const { db, resolver } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.userModelQuota.findUnique.mockResolvedValue({ dailyLimit });
    db.modelUsageDaily.findUnique.mockResolvedValue({ tokensIn: dailyLimit, tokensOut: 0 });
    expect((await resolver.resolve('u', cloud.id)).degraded?.reason).toBe('QUOTA_EXCEEDED');
    expect(db.userModelQuota.findUnique).toHaveBeenCalledWith({ where: { userId_modelId: { userId: 'u', modelId: cloud.id } } });
  });
  it('uses a larger override instead of the default', async () => {
    const { db, resolver } = setup({ DEEPSEEK_API_KEY: 'key' });
    db.userModelQuota.findUnique.mockResolvedValue({ dailyLimit: 300000 });
    db.modelUsageDaily.findUnique.mockResolvedValue({ tokensIn: 200000, tokensOut: 0 });
    expect((await resolver.resolve('u', cloud.id)).degraded).toBeUndefined();
  });
});
