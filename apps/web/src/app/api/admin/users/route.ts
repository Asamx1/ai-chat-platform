import { prisma } from '@aichat/db';
import { requireAdmin, json, error, userSelect } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const params = new URL(req.url).searchParams;
  const raw = params.get('limit') ?? '20';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return error('INVALID_PARAMS', 400);
  const limit = Number(raw), cursor = params.get('cursor'), q = params.get('q');
  const users = await prisma.user.findMany({
    where: { ...(cursor ? { id: { gt: cursor } } : {}), ...(q ? { email: { contains: q, mode: 'insensitive' as const } } : {}) },
    orderBy: { id: 'asc' }, take: limit + 1, select: userSelect,
  });
  const more = users.length > limit;
  if (more) users.pop();
  return json({ users, nextCursor: more ? users.at(-1)!.id : null });
}
