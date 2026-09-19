import { auth } from '@/lib/auth';
import { prisma } from '@aichat/db';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ runId: string }> };

interface UsageRow {
  seatId: string | null;
  tokens: number;
  costMicros: bigint;
}

/**
 * GET /api/runs/[runId]/usage
 * 按 seatId 汇总用量：UsageLog join ProviderCall.participantSnapshotId → 席位快照。
 * 无法关联席位（participantSnapshotId 为空，如单聊 run）归入 seatId: null。
 * 鉴权与 events 路由同款 404 约定。
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { runId } = await ctx.params;

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'not found' }, { status: 404 });

  const run = await prisma.orchestrationRun.findUnique({
    where: { id: runId },
    select: { ownerId: true },
  });
  if (!run || run.ownerId !== userId) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const rows = await prisma.usageLog.findMany({
    where: { runId },
    select: {
      tokens: true,
      costMicros: true,
      call: { select: { participantSnapshot: { select: { seatId: true } } } },
    },
  });

  const bySeat = new Map<string, { seatId: string; calls: number; tokens: number; costMicros: number }>();
  for (const r of rows) {
    const seatId = r.call.participantSnapshot?.seatId ?? '(unassigned)';
    const agg = bySeat.get(seatId) ?? { seatId, calls: 0, tokens: 0, costMicros: 0 };
    agg.calls += 1;
    agg.tokens += r.tokens;
    agg.costMicros += Number(r.costMicros);
    bySeat.set(seatId, agg);
  }

  const seats = [...bySeat.values()].sort((a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true }));
  return Response.json({
    runId,
    seats,
    totals: {
      calls: seats.reduce((s, x) => s + x.calls, 0),
      tokens: seats.reduce((s, x) => s + x.tokens, 0),
      costMicros: seats.reduce((s, x) => s + x.costMicros, 0),
    },
  });
}
