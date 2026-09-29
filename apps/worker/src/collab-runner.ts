import { injectContext } from '@aichat/rag';
import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import {
  runOrchestration,
  CollabCancelledError,
} from '@aichat/orchestrator';
import type {
  CallModel,
  CollabCallModel,
  OrchestratorSeat,
} from '@aichat/orchestrator';
import type { ChatMessage } from '@aichat/providers';
import { releaseLease, renewLease, shouldCancel } from './lease';
import {
  appendEvent,
  processRun,
  recordUsage,
  resolveRunProvider,
  loadPrompt,
  retrieveRunContext,
} from './runner';
import type { RunnerDeps } from './runner';

const RENEW_INTERVAL_MS = 10_000;
const CANCEL_POLL_INTERVAL_MS = 500;
const DEFAULT_TOKEN_BUDGET = 1_000_000;

export type CollabRunnerDeps = RunnerDeps;

interface CollabConfigSnapshot {
  mode?: 'GROUP' | 'CONSENSUS' | 'DEBATE' | undefined;
  seats?: unknown[] | undefined;
  content?: string | undefined;
  userMessageId?: string | null | undefined;
  tokenBudget?: number | undefined;
  maxRounds?: number | undefined;
  modelKey?: string | undefined;
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

  let evidenceMessages: ChatMessage[] = [];
  const invocations = new Map<string, number>();

  const callModel: CallModel = async (seat, messages, callOpts) => {
    // Orchestrator strategies pass a full messages array; seat system prompts may
    // already be embedded as the leading system message — dedupe defensively.
    let chatMessages: ChatMessage[] =
      messages.length > 0 ? messages : seat.systemPrompt
        ? [{ role: 'system', content: seat.systemPrompt }, { role: 'user', content: '' }]
        : [{ role: 'user', content: '' }];
    // Fresh arrays on every call; never add a second evidence envelope on replay.
    if (evidenceMessages.length && !chatMessages.some(message => /^RAG_DATA_/.test(message.content))) {
      chatMessages = [...chatMessages.filter(message => message.role === 'system'),
        ...evidenceMessages, ...chatMessages.filter(message => message.role !== 'system')];
    }
    const prompt = chatMessages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');

    let text = '';
    let tokens = 0;
    let usageJson: Prisma.InputJsonValue | null = null;
    if (!prompt.trim()) throw new Error('EMPTY_PROMPT');
    const invocation = invocations.get(seat.seatId) ?? 0;
    invocations.set(seat.seatId, invocation + 1);
    const resolved = deps.providerFactory
      ? { provider: deps.providerFactory(seat.modelKey), modelKey: seat.modelKey, degraded: undefined }
      : await resolveRunProvider(run.ownerId, seat.modelKey, { runId, attempt: run.attempt, seatId: seat.seatId, invocation });
    const { provider } = resolved;
    if (resolved.degraded) {
      await appendEvent(runId, 'run.degraded', { seatId: seat.seatId, degraded: resolved.degraded });
      await prisma.orchestrationRun.update({ where: { id: runId }, data: {
        degraded: true, degradationReasons: [resolved.degraded.reason],
      } });
    }
    for await (const ev of provider.streamChat(chatMessages, callOpts?.signal ? { signal: callOpts.signal } : undefined)) {
      if (ev.type === 'text-delta') {
        text += ev.delta;
      } else if (ev.type === 'usage') {
        tokens = ev.usage.promptTokens + ev.usage.completionTokens;
        usageJson = { promptTokens: ev.usage.promptTokens, completionTokens: ev.usage.completionTokens };
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      }
    }
    // Account each completed call before the next resolver quota check, even if a later seat fails.
    if (deps.providerFactory) await recordUsage({
      runId, ownerId: run.ownerId, attempt: run.attempt,
      modelKey: resolved.modelKey, content: prompt, tokens, usage: usageJson,
      seatId: seat.seatId,
      participantSnapshotId: seatRows.find((row) => row.seatId === seat.seatId)?.id,
      invocation,
    });
    return text;
  };

  // 单席失败替换（M4 出口项）：席位 callModel 抛错时，找同 role 且
  // seatId 以 '-backup' 结尾的备用席重试一次；无备用则走原有降级/失败路径。
  const callModelWithSubstitution: CollabCallModel = async (seat, prompt, signal) => {
    // collab 策略仍走 (seat, prompt:string, signal) 旧边界(CollabCallModel),
    // 这里适配到新 CallModel 消息数组边界,消除类型双轨与潜在的 string-as-messages 运行隐患
    const toMessages: ChatMessage[] = [...(seat.systemPrompt ? [{ role: 'system' as const, content: seat.systemPrompt }] : []), { role: 'user', content: prompt }];
    const opts = signal ? { signal } : undefined;
    try {
      return await callModel(seat, toMessages, opts);
    } catch (err) {
      if (err instanceof CollabCancelledError || (err instanceof Error && ['QUOTA_OUTCOME_UNKNOWN', 'QUOTA_CALL_EXISTS'].includes(err.message))) throw err;
      const backup = seats.find(
        (s) => s.seatId.endsWith('-backup') && s.seatId !== seat.seatId && s.role === seat.role,
      );
      if (!backup) throw err;
      await appendEvent(runId, 'collab.seat.substituted', { from: seat.seatId, to: backup.seatId });
      const backupMessages: ChatMessage[] = [...(backup.systemPrompt ? [{ role: 'system' as const, content: backup.systemPrompt }] : []), { role: 'user', content: prompt }];
      return callModel(backup, backupMessages, opts);
    }
  };

  try {
    const content = await loadPrompt(run.conversationId, snapshot);
    const rag = await retrieveRunContext(run.ownerId, run.conversationId, content);
    if (rag.hits.length) {
      // Build once so all seats/rounds share the same selected evidence and nonce.
      evidenceMessages = injectContext([{ role: 'user', content: '' }], rag.hits,
        { maxContext: Number.MAX_SAFE_INTEGER, maxOutput: 2048 }).messages.slice(0, -1);
    }
    await appendEvent(runId, 'run.started', { mode: snapshot.mode, seats: seats.length });

    let finalOutput = '';
    let runDegraded = false;
    let degradationReasons: string[] = [];
    for await (const ev of runOrchestration({
      mode: snapshot.mode,
      seats,
      userContent: content,
      tokenBudget: snapshot.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      maxRounds: snapshot.maxRounds ?? 2,
      callModel: callModelWithSubstitution,
      signal: abort.signal,
      shouldCancel: cancelRequested,
    })) {
      if (ev.type === 'final') {
        finalOutput = ev.output;
        runDegraded = ev.degraded === true;
        degradationReasons = ev.reasons ?? [];
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
        // 消息列表 API 以 citations 数组(含空数组)判定 assistant 角色,缺省会被渲染成用户消息。
        citations: [],
      },
    });
    await appendEvent(runId, 'run.succeeded', { messageId: assistant.id });
    // degraded 落库：策略结果带 degraded 标志时持久化（字段 M0 schema 已有）。
    await prisma.orchestrationRun.update({
      where: { id: runId },
      data: {
        status: 'SUCCEEDED',
        ...(runDegraded ? { degraded: true, degradationReasons } : {}),
      },
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
