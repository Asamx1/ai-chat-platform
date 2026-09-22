import { prisma } from '@aichat/db';
import { requireAdmin, json } from '@/lib/admin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
  const runs = await prisma.orchestrationRun.findMany({
    take: 50, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true, status: true, createdAt: true, updatedAt: true,
      conversation: { select: { type: true } },
      events: {
        where: { type: { in: ['run.succeeded', 'run.failed', 'run.cancelled'] } },
        orderBy: { seq: 'desc' }, take: 1,
        select: { type: true, payload: true, createdAt: true },
      },
    },
  });
  const now = Date.now();
  return json({ runs: runs.map(run => {
    const active = run.status === 'RUNNING' || run.status === 'PENDING';
    const terminal = run.events[0];
    const payload = terminal?.payload;
    const failure = run.status === 'FAILED' && terminal?.type === 'run.failed' &&
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.error : null;
    return {
      id: run.id, type: run.conversation.type,
      status: run.status === 'SUCCEEDED' ? 'COMPLETE' : run.status,
      durationMs: Math.max(0, (active ? now : (terminal?.createdAt ?? run.updatedAt).getTime()) - run.createdAt.getTime()),
      createdAt: run.createdAt.toISOString(),
      error: typeof failure === 'string' ? failure : null,
    };
  }) });
}
