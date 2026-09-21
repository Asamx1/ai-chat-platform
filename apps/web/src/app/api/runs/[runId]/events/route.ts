import { auth } from '@/lib/auth';
import { prisma } from '@aichat/db';
import { HEARTBEAT, isTerminalEvent, sseEncode } from '@/lib/sse';

export const dynamic = 'force-dynamic';

/** 追平后轮询增量的间隔。 */
const POLL_INTERVAL_MS = 2000;
/** 心跳注释行的间隔。 */
const HEARTBEAT_INTERVAL_MS = 15000;

/** OrchestrationRun.status 的终态集合（与 isTerminalEvent 的事件类型对应）。 */
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { runId } = await ctx.params;

  // 鉴权与所有权：未登录 / run 不存在 / 非本人一律 404，不泄露 run 是否存在。
  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'not found' }, { status: 404 });

  const run = await prisma.orchestrationRun.findUnique({
    where: { id: runId },
    select: { ownerId: true, status: true },
  });
  if (!run || run.ownerId !== userId) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  // 起始游标：Last-Event-ID 头优先，其次 ?after=N，默认 0。
  const headerVal = request.headers.get('last-event-id');
  const rawAfter = headerVal ?? new URL(request.url).searchParams.get('after');
  let after = Number(rawAfter ?? 0);
  if (!Number.isFinite(after) || after < 0) after = 0;

  // ?format=json：一次性返回全量事件（时间线 UI 等非 SSE 消费方），after 语义与 SSE 一致。
  if (new URL(request.url).searchParams.get('format') === 'json') {
    const events = await prisma.runEvent.findMany({
      where: { runId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
    });
    return Response.json({
      events: events.map((ev) => ({
        runId,
        seq: ev.seq,
        type: ev.type,
        time: ev.createdAt.toISOString(),
        payload: ev.payload,
      })),
    });
  }

  const encoder = new TextEncoder();
  const signal = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let closed = false;
      const send = (chunk: string): void => {
        if (!closed && !signal.aborted) controller.enqueue(encoder.encode(chunk));
      };
      let lastHeartbeat = Date.now();
      try {
        while (!signal.aborted) {
          const events = await prisma.runEvent.findMany({
            where: { runId, seq: { gt: after } },
            orderBy: { seq: 'asc' },
          });

          if (events.length === 0) {
            // 无新数据：run 已终态则立即收尾，否则等待后继续轮询。
            const current = await prisma.orchestrationRun.findUnique({
              where: { id: runId },
              select: { status: true },
            });
            if (current && TERMINAL_RUN_STATUSES.has(current.status)) {
              // 明确通知客户端已追平终态，避免失败后 EventSource 无限重连。
              send(`data: ${JSON.stringify({ type: 'stream.end', runId })}\n\n`);
              break;
            }
            if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
              send(HEARTBEAT);
              lastHeartbeat = Date.now();
            }
            await sleep(POLL_INTERVAL_MS, signal);
            continue;
          }

          let terminal = false;
          for (const ev of events) {
            if (signal.aborted) break;
            send(
              sseEncode(ev.seq, {
                runId,
                seq: ev.seq,
                type: ev.type,
                time: ev.createdAt.toISOString(),
                payload: ev.payload,
              }),
            );
            after = ev.seq;
            lastHeartbeat = Date.now();
            // 失败事件可能来自旧执行者/可重试 attempt，继续读取后续事件。
            if (isTerminalEvent(ev.type) && ev.type !== 'run.failed') {
              terminal = true;
              break;
            }
          }
          if (terminal) break;
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开时 close 可能抛错，忽略。
        }
      }
    },
    cancel(): void {
      // request.signal abort 时 ReadableStream 会被 cancel；轮询靠 signal.aborted 退出。
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    },
  });
}
