import { prisma } from '@aichat/db';
import { DAILY_CLOUD_TOKEN_LIMIT } from '@aichat/providers/resolver';
import { requireAdmin, json, error } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const userId = new URL(req.url).searchParams.get('userId');
  if (!userId) return error('INVALID_PARAMS', 400);
  if (!await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) return error('NOT_FOUND', 404);
  const [models, quotas] = await Promise.all([
    prisma.modelRegistry.findMany({ orderBy: { id: 'asc' }, select: { id: true } }),
    prisma.userModelQuota.findMany({ where: { userId } }),
  ]);
  return json({ items: models.map(model => {
    const quota = quotas.find(q => q.modelId === model.id);
    return { modelId: model.id, dailyLimit: quota?.dailyLimit ?? null,
      effectiveLimit: quota?.dailyLimit ?? DAILY_CLOUD_TOKEN_LIMIT, source: quota ? 'override' : 'default' };
  }) });
}
