import { prisma } from '@aichat/db';
import { lockQuota } from '@aichat/providers/quota';
import { requireAdmin, json, error, readBody } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ userId: string; modelId: string }> };
async function write(req: Request, context: Context, remove: boolean) {
  const guard = await requireAdmin(req);
  if (guard.response) return guard.response;
  const { userId, modelId } = await context.params;
  const body = remove ? null : await readBody(req);
  const limit = body?.dailyLimit;
  if (!remove && (!body || Object.keys(body).length !== 1 || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 2147483647)) {
    return error('INVALID_PARAMS', 400);
  }
  return prisma.$transaction(async tx => {
    await lockQuota(tx, userId, modelId);
    if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } }) ||
      !await tx.modelRegistry.findUnique({ where: { id: modelId }, select: { id: true } })) return error('NOT_FOUND', 404);
    if (remove) {
      await tx.userModelQuota.deleteMany({ where: { userId, modelId } });
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' } });
    }
    const quota = await tx.userModelQuota.upsert({ where: { userId_modelId: { userId, modelId } },
      create: { userId, modelId, dailyLimit: limit as number }, update: { dailyLimit: limit as number } });
    return json({ quota });
  });
}
export function PUT(req: Request, context: Context) { return write(req, context, false); }
export function DELETE(req: Request, context: Context) { return write(req, context, true); }
