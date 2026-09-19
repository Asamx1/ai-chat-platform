import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import {
  runOrchestration,
  CollabCancelledError,
} from '@aichat/orchestrator';
import type {
  CallModel,
  OrchestratorSeat,
} from '@aichat/orchestrator';
import type { ChatMessage } from '@aichat/providers';
import { releaseLease, renewLease, shouldCancel } from './lease';
import {
  appendEvent,
  processRun,
  recordUsage,
  DEFAULT_PROVIDER_FACTORY,
} from './runner';
import type { RunnerDeps, WorkerProviderFactory } from './runner';

const RENEW_INTERVAL_MS = 10_000;
const CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_TOKEN_BUDGET = 1_000_000;

export type CollabRunnerDeps = RunnerDeps;

interface CollabConfigSnapshot {
  mode?: 'GROUP' | 'CONSENSUS' | 'DEBATE';
  seats?: unknown[];
  content?: string;
  userMessageId?: string | null;
  tokenBudget?: number;
  modelKey?: string;
}

/**
 * 协作 run 处理入口：configSnapshot 无 mode 或席位 <2 时回落到单席 processRun。
 * 协作路径：snapshot 行映射席位 → orchestrator engine 按策略执行 →
 * 事件经 appendEvent 落盘（seq 延续 MAX(seq)+1 机制）→ assistant Message +
 * 逐席幂等记账 + 终态，最后释放 lease。
 */
export async function processCollabRun(
  runId: string,
  workerId: string,
  deps: CollabRunnerDeps = {},
): Promise<void> {
  const providerFactory: WorkerProviderFactory = deps.providerFactory ?? DEFAULT_PROVIDER_FACTORY;
  const renewIntervalMs = deps.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const cancelPollIntervalMs = deps.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;

  const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
  if (!run) return;

  const snapshot = (run.configSnapshot ?? {}) as CollabConfigSnapshot;
  if (!snapshot.mode || (snapshot.seats?.length ?? 0) < 2) {
    // 回落：mode 缺省或单席 → 现有单席路径。
    return processRun(runId, workerId, deps);
  }

  // 幂等守卫：终态 run 不再执行（与 runner.ts 一致）。
  if (run.status === 'SUCCEEDED' || run.status === 'CANCELLED') {
    await releaseLease(runId, workerId);
    return;
  }
  if (run.status === 'FAILED' && run.attempt >= 3) {
    await releaseLease(runId, workerId);
    return;
  }

  const seatRows = await prisma.runParticipantSnapshot.findMany({ where: { runId } });
  if (seatRows.length < 2) {
    await appendEvent(runId, 'run.failed', { error: 'participant snapshots missing' });
    await prisma.orchestrationRun.update({ where: { id: runId }, data: { status: 'FAILED' } });
    await releaseLease(runId, workerId);
    return;
  }

  // 心跳：后台续租，丢租时中止 provider 流。
  const abort = new AbortController();
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void renewLease(runId, workerId)
      .then((n) => {
        if (n === 0) {
          lostLease = true;
          abort.abort();
        }
      })
      .catch(() => {
        /* 瞬时失败下一轮再试 */
      });
  }, renewIntervalMs);

  let lastCancelCheck = 0;
  const cancelRequested = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastCancelCheck < cancelPollIntervalMs) return false;
    lastCancelCheck = now;
    return shouldCancel(runId);
  };

  const seats: OrchestratorSeat[] = seatRows.map((row) => ({
    seatId: row.seatId,
    modelKey: row.modelKey,
    role: ((row.params as { role?: string }) ?? {}).role ?? 'member',
    systemPrompt: row.systemPrompt,
  }));

  // 逐席用量记录：callModel 内部捕获，seatId → 记账所需字段。
  const seatUsage = new Map<
    string,
    { modelKey: string; prompt: string; tokens: number; usage: Prisma.InputJsonValue | null }
  >();

  const callModel: CallModel = async (seat, prompt, signal) => {
    const messages: ChatMessage[] = [];
    if (seat.systemPrompt) messages.push({ role: 'system', content: seat.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let text = '';
    let tokens = 0;
    let usageJson: Prisma.InputJsonValue | null = null;
    const provider = providerFactory(seat.modelKey);
    for await (const ev of provider.streamChat(messages, signal ? { signal } : undefined)) {
      if (ev.type === 'text-delta') {
        text += ev.delta;
      } else if (ev.type === 'usage') {
        tokens = ev.usage.promptTokens + ev.usage.completionTokens;
        usageJson = ev.usage as Prisma.InputJsonValue;
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      }
    }
    const prev = seatUsage.get(seat.seatId);
    seatUsage.set(seat.seatId, {
      modelKey: seat.modelKey,
      prompt,
      tokens: (prev?.tokens ?? 0) + tokens,
      usage: usageJson ?? prev?.usage ?? null,
    });
    // E1 契约：CallModel 返回 string（usage 走 seatUsage 旁路收集）。
    return text;
  };

  try {
    await appendEvent(runId, 'run.started', { mode: snapshot.mode, seats: seats.length });

    let finalOutput = '';
    for await (const ev of runOrchestration({
      mode: snapshot.mode,
      seats,
      userContent: snapshot.content ?? '',
      tokenBudget: snapshot.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      callModel,
      signal: abort.signal,
      shouldCancel: cancelRequested,
    })) {
      if (ev.type === 'final') {
        finalOutput = ev.output;
        continue;
      }
      const payload: Record<string, unknown> = { ...ev };
      delete payload.type;
      await appendEvent(runId, `collab.${ev.type}`, payload);
    }

    if (lostLease) return;

    const assistant = await prisma.message.create({
      data: {
        conversationId: run.conversationId,
        content: finalOutput,
        status: 'COMPLETE',
      },
    });
    // 逐席幂等记账（recordUsage 以 requestHash 去重，崩溃重放不双计）。
    for (const [sid, u] of seatUsage.entries()) {
      await recordUsage({
        runId,
        ownerId: run.ownerId,
        attempt: run.attempt,
        modelKey: u.modelKey,
        content: u.prompt,
        tokens: u.tokens,
        usage: u.usage,
        seatId: sid,
      });
    }
    await appendEvent(runId, 'run.succeeded', { messageId: assistant.id });
    await prisma.orchestrationRun.update({
      where: { id: runId },
      data: { status: 'SUCCEEDED' },
    });
  } catch (err) {
    if (lostLease) return;
    if (err instanceof CollabCancelledError || (await cancelRequested())) {
      await appendEvent(runId, 'run.cancelled', {});
      await prisma.orchestrationRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', cancelRequested: false },
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await appendEvent(runId, 'run.failed', { error: message });
      await prisma.orchestrationRun.update({
        where: { id: runId },
        data: { status: 'FAILED' },
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!lostLease) await releaseLease(runId, workerId);
  }
}
