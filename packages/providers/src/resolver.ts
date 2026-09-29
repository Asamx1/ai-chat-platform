import { DAILY_CLOUD_TOKEN_LIMIT } from '@aichat/crypto/constants';

export { DAILY_CLOUD_TOKEN_LIMIT };

export const PROVIDER_ENV_KEYS: Readonly<Record<string, string | undefined>> = Object.freeze({
  deepseek: 'DEEPSEEK_API_KEY',
});

export interface RegistryModel {
  id: string;
  modelKey: string;
  providerId: string;
  kind: string;
  baseUrl: string | null;
  adapter: string | null;
  isDefault: boolean;
  provider: { kind: string; baseUrl: string };
}

type DailyKey = { userId: string; modelId: string; date: Date };
export interface UsageStore {
  modelUsageDaily: {
    findUnique(args: { where: { userId_modelId_date: DailyKey } }): Promise<{ tokensIn: number; tokensOut: number; reservedTokens?: number } | null>;
    upsert(args: {
      where: { userId_modelId_date: DailyKey };
      create: DailyKey & { tokensIn: number; tokensOut: number };
      update: { tokensIn: { increment: number }; tokensOut: { increment: number } };
    }): Promise<unknown>;
  };
}

export interface ResolverStore extends UsageStore {
  userModelQuota: {
    findUnique(args: { where: { userId_modelId: { userId: string; modelId: string } } }): Promise<{ dailyLimit: number } | null>;
  };
  modelRegistry: {
    findUnique(args: { where: { id: string }; include: { provider: true } }): Promise<RegistryModel | null>;
    findFirst(args: {
      where: { kind?: string; provider: { kind?: string; enabled?: boolean }; isDefault?: boolean; modelKey?: string };
      include: { provider: true };
      orderBy: { id: 'asc' } | { updatedAt: 'desc' };
    }): Promise<RegistryModel | null>;
  };
  apiKey: {
    findUnique(args: { where: { userId_provider: { userId: string; provider: string } } }): Promise<{ ciphertext: string } | null>;
  };
}

export class ModelResolutionError extends Error {
  constructor(public readonly code: 'UNKNOWN_MODEL' | 'NO_LOCAL_MODEL', public readonly status: number) {
    super(code === 'UNKNOWN_MODEL' ? '所选模型不存在或不可用，请重新选择模型。' : '云端模型暂不可用，且没有可用的本地回退模型，请检查模型配置。');
    this.name = 'ModelResolutionError';
  }
}

export interface ResolvedModel {
  modelId: string;
  model: string;
  provider: string;
  adapter: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  keySource: 'db' | 'env' | null;
  degraded?: { reason: 'NO_KEY' | 'QUOTA_EXCEEDED'; from: string };
}

export function usageDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Pass the caller's Prisma transaction so daily usage and run accounting commit together. */
export async function incrementDailyUsage(
  tx: Pick<UsageStore, 'modelUsageDaily'>,
  userId: string,
  modelId: string,
  tokensIn: number,
  tokensOut: number,
  now = new Date(),
): Promise<void> {
  if (![tokensIn, tokensOut].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError('Token counts must be non-negative safe integers');
  }
  const key = { userId, modelId, date: usageDate(now) };
  await tx.modelUsageDaily.upsert({
    where: { userId_modelId_date: key },
    create: { ...key, tokensIn, tokensOut },
    update: { tokensIn: { increment: tokensIn }, tokensOut: { increment: tokensOut } },
  });
}

export function createResolver(
  db: ResolverStore,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    now?: () => Date;
    decrypt?: (ciphertext: string) => string | Promise<string>;
  } = {},
) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const decrypt = options.decrypt ?? (async (stored: string) => (await import('@aichat/crypto')).decrypt(stored));

  function result(row: RegistryModel, apiKey = '', keySource: ResolvedModel['keySource'] = null): ResolvedModel {
    return {
      modelId: row.id, model: row.modelKey, provider: row.providerId,
      adapter: row.adapter ?? (row.provider.kind === 'ollama' ? 'ollama' : 'openai-compatible'), kind: row.kind,
      baseUrl: row.baseUrl ?? row.provider.baseUrl, apiKey, keySource,
    };
  }

  async function fallback(from: string, reason: 'NO_KEY' | 'QUOTA_EXCEEDED'): Promise<ResolvedModel> {
    const local = await db.modelRegistry.findFirst({
      where: {
        kind: 'local', provider: { kind: 'ollama' },
        ...(env.LOCAL_DEFAULT_MODEL ? { modelKey: env.LOCAL_DEFAULT_MODEL } : { isDefault: true }),
      },
      include: { provider: true }, orderBy: { id: 'asc' },
    });
    if (!local) throw new ModelResolutionError('NO_LOCAL_MODEL', 503);
    return { ...result(local), degraded: { reason, from } };
  }

  return {
    fallback,
    async resolve(userId: string, modelId: string): Promise<ResolvedModel> {
      // Prefer the registry id; legacy clients and snapshots may still send modelKey.
      const row = await db.modelRegistry.findUnique({ where: { id: modelId }, include: { provider: true } })
        ?? await db.modelRegistry.findFirst({
          where: { modelKey: modelId, provider: { enabled: true } },
          include: { provider: true }, orderBy: { updatedAt: 'desc' },
        });
      if (!row) throw new ModelResolutionError('UNKNOWN_MODEL', 400);
      if (row.kind !== 'cloud') return result(row);
      const stored = await db.apiKey.findUnique({ where: { userId_provider: { userId, provider: row.providerId } } });
      let key: string | undefined;
      let source: ResolvedModel['keySource'] = null;
      if (stored) {
        key = await decrypt(stored.ciphertext);
        source = 'db';
      } else {
        const envKey = Object.hasOwn(PROVIDER_ENV_KEYS, row.providerId) ? PROVIDER_ENV_KEYS[row.providerId] : undefined;
        key = envKey ? env[envKey]?.trim() : undefined;
        if (key) source = 'env';
      }
      if (!key) return fallback(modelId, 'NO_KEY');
      const usage = await db.modelUsageDaily.findUnique({
        where: { userId_modelId_date: { userId, modelId: row.id, date: usageDate(now()) } },
      });
      const quota = await db.userModelQuota.findUnique({ where: { userId_modelId: { userId, modelId: row.id } } });
      const limit = quota?.dailyLimit ?? DAILY_CLOUD_TOKEN_LIMIT;
      if ((usage ? usage.tokensIn + usage.tokensOut + (usage.reservedTokens ?? 0) : 0) >= limit) {
        return fallback(modelId, 'QUOTA_EXCEEDED');
      }
      const resolved = result(row, key, source);
      if (source === 'env') resolved.baseUrl = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
      return resolved;
    },
  };
}
