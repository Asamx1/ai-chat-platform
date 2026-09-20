import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@aichat/db';
import { DAILY_CLOUD_TOKEN_LIMIT } from '@aichat/providers';
import { auth } from '@/lib/auth';

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const userId = session.user.id;
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  const [registry, keys, usage] = await Promise.all([
    prisma.modelRegistry.findMany({ include: { provider: true }, orderBy: { modelKey: 'asc' } }),
    prisma.apiKey.findMany({ where: { userId }, select: { provider: true } }),
    prisma.modelUsageDaily.findMany({ where: { userId, date } }),
  ]);
  const configured = new Set(keys.map((key) => key.provider));
  return NextResponse.json({
    models: registry.map((model) => {
      const cloud = model.kind === 'cloud';
      const keySource = !cloud ? null : configured.has(model.providerId) ? 'db'
        : model.providerId === 'deepseek' && process.env.DEEPSEEK_API_KEY?.trim() ? 'env' : null;
      const daily = usage.find((row) => row.modelId === model.modelKey);
      const used = (daily?.tokensIn ?? 0) + (daily?.tokensOut ?? 0);
      const capabilities = model.capabilities as { label?: string | undefined };
      return {
        id: model.modelKey,
        label: capabilities?.label ?? model.modelKey,
        provider: model.providerId,
        kind: model.kind,
        available: model.provider.enabled && (!cloud || (keySource !== null && used <= DAILY_CLOUD_TOKEN_LIMIT)),
        keySource,
        quotaRemaining: cloud ? Math.max(0, DAILY_CLOUD_TOKEN_LIMIT - used) : null,
      };
    }),
  });
}
