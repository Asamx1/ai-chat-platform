import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import { OllamaProvider, FakeProvider } from '@aichat/providers';
import type { ProviderAdapter } from '@aichat/providers';
import { releaseLease, renewLease, shouldCancel } from './lease';

/** 可恢复的执行状态，持久化在 RunCheckpoint.stateJson。 */
export interface RunState {
  seq: number;
  assistantMessageId: string | null;
  accumulated: string;
}

export type WorkerProviderFactory = (modelKey: string) => ProviderAdapter;

export interface RunnerDeps {
  /** 默认本机 Ollama；测试注入 FakeProvider。 */
  providerFactory?: WorkerProviderFactory;
  /** 心跳间隔，测试可调小。 */
  renewIntervalMs?: number;
  /** cancel 查询节流间隔。 */
  cancelPollIntervalMs?: number;
}

export const DEFAULT_PROVIDER_FACTORY: WorkerProviderFactory = (modelKey) => {
  // 故障注入测试通道：SLOWMO=1 且 modelKey 以 slowmo 开头 → 慢速 Fake（每 token 100ms）。
  if (process.env.SLOWMO === '1' && modelKey.startsWith('slowmo')) {
    return new FakeProvider(
      Array.from({ length: 40 }, (_, i) => `chunk${i} `),
      { perTokenDelayMs: 150 },
    );
  }
  return new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: modelKey });
};

const RENEW_INTERVAL_MS = 10_000;
const CANCEL_POLL_INTERVAL_MS = 500;
const CHECKPOINT_EVERY_DELTAS = 20;
const CHECKPOINT_EVERY_MS = 2_000;

/**
 * 追加 RunEvent。seq 用单条 SQL 内的子查询 MAX(seq)+1 计算，
 * 配合 (runId, seq) 唯一约束，多进程并发追加不会写出重复 seq。
 */
export async function appendEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const id = randomUUID();
  const count = await prisma.$executeRawUnsafe(
    `INSERT INTO "RunEvent" (id, "runId", seq, type, payload, "createdAt")
     VALUES (
       $1, $2,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM "RunEvent" WHERE "runId" = $2),
       $3, $4::jsonb, now()
     )`,
    id,
    runId,
    type,
    JSON.stringify(payload),
  );
  if (count !== 1) throw new Error(`appendEvent failed for run ${runId}`);
  const row = await prisma.runEvent.findUnique({ where: { id }, select: { seq: true } });
  return row?.seq ?? 0;
}

async function loadState(runId: string): Promise<{ state: RunState; version: number }> {
  const latest = await prisma.runCheckpoint.findFirst({
    where: { runId },
    orderBy: { version: 'desc' },
  });
  if (latest) {
    const s = latest.stateJson as Partial<RunState>;
    return {
      state: {
        seq: s.seq ?? 0,
        assistantMessageId: s.assistantMessageId ?? null,
        accumulated: s.accumulated ?? '',
      },
      version: latest.version,
    };
  }
  return { state: { seq: 0, assistantMessageId: null, accumulated: '' }, version: 0 };
}

async function saveCheckpoint(runId: string, state: RunState, version: number): Promise<number> {
  await prisma.runCheckpoint.create({
    data: {
      runId,
      version: version + 1,
      stateJson: state as Prisma.InputJsonValue,
    },
  });
  return version + 1;
}

/** 幂等记账：requestHash 已存在则跳过（崩溃重放不会双计）。 */
export async function recordUsage(opts: {
  runId: string;
  ownerId: string;
  attempt: number;
  modelKey: string;
  content: string;
  tokens: number;
  usage: Prisma.InputJsonValue | null;
}): Promise<void> {
  const requestHash = createHash('sha256')
    .update(`${opts.modelKey}\n${opts.content}\n${opts.runId}`)
    .digest('hex');
  const existing = await prisma.providerCall.findUnique({
    where: { requestHash },
    select: { id: true },
  });
  if (existing) return;
  const call = await prisma.providerCall.create({
    data: {
      runId: opts.runId,
      attempt: opts.attempt,
      requestHash,
      usage: opts.usage,
      endedAt: new Date(),
    },
  });
  await prisma.usageLog.create({
    data: {
      userId: opts.ownerId,
      runId: opts.runId,
      callId: call.id,
      tokens: opts.tokens,
      costMicros: 0n,
    },
  });
}

async function upsertAssistantMessage(
  conversationId: string,
  state: RunState,
): Promise<string> {
  if (state.assistantMessageId) {
    await prisma.message.update({
      where: { id: state.assistantMessageId },
      data: { content: state.accumulated, status: 'COMPLETE' },
    });
    return state.assistantMessageId;
  }
  const msg = await prisma.message.create({
    data: {
      conversationId,
      content: state.accumulated,
      status: 'COMPLETE',
    },
  });
  return msg.id;
}

class CancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * 处理单个 run：从最新 checkpoint 恢复 → 流式执行 → 落盘事件/checkpoint →
 * 幂等记账 → 终态。无论成败最后释放 lease。
 */
export async function processRun(runId: string, workerId: string, deps: RunnerDeps = {}): Promise<void> {
  const providerFactory = deps.providerFactory ?? DEFAULT_PROVIDER_FACTORY;
  const renewIntervalMs = deps.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const cancelPollIntervalMs = deps.cancelPollIntervalMs ?? CANCEL_POLL_INTERVAL_MS;

  const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
  if (!run) return;

  const snapshot = (run.configSnapshot ?? {}) as { content?: string; modelKey?: string };
  const content = snapshot.content ?? '';
  const modelKey = snapshot.modelKey ?? '';
  if (!modelKey) {
    await appendEvent(runId, 'run.failed', { error: 'configSnapshot missing modelKey' });
    await prisma.orchestrationRun.update({ where: { id: runId }, data: { status: 'FAILED' } });
    await releaseLease(runId, workerId);
    return;
  }

  // 幂等守卫：终态 run 不再执行（防重复 processRun 产生第二个 succeeded/failed）。
  if (run.status === 'SUCCEEDED' || run.status === 'CANCELLED') {
    await releaseLease(runId, workerId);
    return;
  }
  if (run.status === 'FAILED' && run.attempt >= 3) {
    await releaseLease(runId, workerId);
    return;
  }

  // 心跳：后台定时续租；丢租（返回 0）时中止 provider 流。
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
        /* 网络抖动等瞬时失败：下一轮心跳再试，TTL 内不丢租 */
      });
  }, renewIntervalMs);

  let lastCancelCheck = 0;
  const cancelRequested = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastCancelCheck < cancelPollIntervalMs) return false;
    lastCancelCheck = now;
    return shouldCancel(runId);
  };

  let { state, version } = await loadState(runId);
  const resumed = version > 0;

  try {
    if (!resumed) {
      state.seq = await appendEvent(runId, 'run.started', { modelKey });
    }

    const provider = providerFactory(modelKey);
    let tokens = 0;
    let usageJson: Prisma.InputJsonValue | null = null;
    let deltasSinceCheckpoint = 0;
    let lastCheckpointAt = Date.now();

    for await (const ev of provider.streamChat(
      [{ role: 'user', content }],
      { signal: abort.signal },
    )) {
      if (await cancelRequested()) throw new CancelledError();

      if (ev.type === 'text-delta') {
        state.accumulated += ev.delta;
        state.seq = await appendEvent(runId, 'provider.delta', { delta: ev.delta });
        deltasSinceCheckpoint += 1;
        if (
          deltasSinceCheckpoint >= CHECKPOINT_EVERY_DELTAS ||
          Date.now() - lastCheckpointAt >= CHECKPOINT_EVERY_MS
        ) {
          // 首个 checkpoint 顺带落 assistant 消息占位，重放时可原位更新。
          if (!state.assistantMessageId) {
            const msg = await prisma.message.create({
              data: {
                conversationId: run.conversationId,
                content: state.accumulated,
                status: 'STREAMING',
              },
            });
            state.assistantMessageId = msg.id;
          }
          version = await saveCheckpoint(runId, state, version);
          deltasSinceCheckpoint = 0;
          lastCheckpointAt = Date.now();
        }
      } else if (ev.type === 'usage') {
        tokens = ev.usage.promptTokens + ev.usage.completionTokens;
        usageJson = ev.usage as Prisma.InputJsonValue;
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      }
      // 'done'：流出循环后统一收尾。
    }

    if (lostLease) return; // 租约被接管：不再写终态，让新 owner 继续。

    if (abort.signal.aborted && !(await cancelRequested())) {
      // 本地 abort 但非用户取消（丢租已在上面处理）——按失败收尾。
      throw new Error('aborted');
    }

    state.assistantMessageId = await upsertAssistantMessage(run.conversationId, state);
    version = await saveCheckpoint(runId, state, version);
    await recordUsage({
      runId,
      ownerId: run.ownerId,
      attempt: run.attempt,
      modelKey,
      content,
      tokens,
      usage: usageJson,
    });
    state.seq = await appendEvent(runId, 'run.succeeded', {});
    await prisma.orchestrationRun.update({ where: { id: runId }, data: { status: 'SUCCEEDED' } });
  } catch (err) {
    if (lostLease) return;
    if (err instanceof CancelledError) {
      state.seq = await appendEvent(runId, 'run.cancelled', {});
      await prisma.orchestrationRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', cancelRequested: false },
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await appendEvent(runId, 'run.failed', { error: message });
      await prisma.orchestrationRun.update({ where: { id: runId }, data: { status: 'FAILED' } });
    }
  } finally {
    clearInterval(heartbeat);
    if (!lostLease) await releaseLease(runId, workerId);
  }
}
