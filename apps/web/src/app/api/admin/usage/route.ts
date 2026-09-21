import { prisma } from '@aichat/db';
import { requireAdmin, json, error } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function date(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const params = new URL(req.url).searchParams;
  const from = date(params.get('from')), to = date(params.get('to'));
  if (!from || !to || to <= from || +to - +from > 31 * 86400000) return error('INVALID_PARAMS', 400);
  const userId = params.get('userId'), modelId = params.get('modelId');
  if (userId === '' || modelId === '') return error('INVALID_PARAMS', 400);
  if ((userId && !await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) ||
      (modelId && !await prisma.modelRegistry.findUnique({ where: { id: modelId }, select: { id: true } }))) return error('NOT_FOUND', 404);
  const rows = await prisma.$queryRaw<Array<{ date: Date; userId: string; modelId: string; tokens: bigint }>>`
    SELECT date,"userId","modelId", SUM("tokensIn"::bigint+"tokensOut") AS tokens
    FROM "ModelUsageDaily" WHERE date >= ${from}::date AND date < ${to}::date
    AND (${userId}::text IS NULL OR "userId"=${userId})
    AND (${modelId}::text IS NULL OR "modelId"=${modelId})
    GROUP BY date,"userId","modelId" ORDER BY date,"userId","modelId"`;
  return json({ rows: rows.map(row => ({ ...row, date: row.date.toISOString().slice(0, 10), tokens: row.tokens.toString() })) });
}
