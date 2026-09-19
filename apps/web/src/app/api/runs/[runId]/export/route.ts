import { createHash } from 'node:crypto';
import { auth } from '@/lib/auth';
import { prisma } from '@aichat/db';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ runId: string }> };

/** 导出体版本号：结构变更时递增。 */
const EXPORT_VERSION = 1;

/** sha256(JSON.stringify(configSnapshot)) 截 16 hex，用于核对运行配置一致性。 */
function configHashOf(configSnapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(configSnapshot)).digest('hex').slice(0, 16);
}

/**
 * GET /api/runs/[runId]/export
 * 全量导出一次协作运行（run / 席位快照 / 事件流 / 用量 / provider 调用），
 * 以 JSON 附件下载。鉴权与 events 路由同款 404 约定（未登录/非本人不泄露存在性）。
 */
export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { runId } = await ctx.params;

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'not found' }, { status: 404 });

  const run = await prisma.orchestrationRun.findUnique({
    where: { id: runId },
    include: {
      participantSnapshots: true,
      events: { orderBy: { seq: 'asc' } },
      usageLogs: true,
      providerCalls: { orderBy: { startedAt: 'asc' } },
    },
  });
  if (!run || run.ownerId !== userId) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // run 主体：不含 owner 关联对象（email 等敏感信息只留在 ownerId 标识）。
  const { participantSnapshots, events, usageLogs, providerCalls, ...runFields } = run;

  const body = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    run: {
      ...runFields,
      // BigInt 字段不会出现在 run 主体（costMicros 仅在 usage），此处 JSON 安全。
      configHash: configHashOf(run.configSnapshot),
    },
    seats: participantSnapshots.map((s) => ({
      id: s.id,
      seatId: s.seatId,
      providerKey: s.providerKey,
      modelKey: s.modelKey,
      systemPrompt: s.systemPrompt,
      params: s.params,
      pricingVersion: s.pricingVersion,
    })),
    events: events.map((ev) => ({
      seq: ev.seq,
      type: ev.type,
      time: ev.createdAt.toISOString(),
      payload: ev.payload,
    })),
    usage: usageLogs.map((u) => ({
      id: u.id,
      callId: u.callId,
      tokens: u.tokens,
      costMicros: Number(u.costMicros),
      createdAt: u.createdAt.toISOString(),
    })),
    calls: providerCalls.map((c) => ({
      id: c.id,
      participantSnapshotId: c.participantSnapshotId,
      attempt: c.attempt,
      usage: c.usage,
      error: c.error,
      startedAt: c.startedAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
    })),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="run-${runId}.json"`,
      'cache-control': 'no-store',
    },
  });
}
