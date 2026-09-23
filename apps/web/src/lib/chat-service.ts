import { quotaProvider } from '@aichat/providers/quota-provider';
import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import {

  createConversation,
  createMessage,
} from '@aichat/db';
import { createResolver } from '@aichat/providers';
import type { ProviderAdapter, ResolvedModel } from '@aichat/providers';
import { injectContext, retrieveContext, revalidateContext } from './rag-context';
import type { RagSnapshot } from './rag-context';

const resolver = createResolver(prisma);

/** M1：同进程流式执行。runId → AbortController / seq 计数器（模块级）。 */
const abortControllers = new Map<string, AbortController>();
const seqCounters = new Map<string, number>();

function nextSeq(runId: string): number {
  const seq = seqCounters.get(runId) ?? 0;
  seqCounters.set(runId, seq + 1);
  return seq;
}

export type ChatProviderFactory = (modelKey: string) => ProviderAdapter;

/** Explicit test override; production always resolves the user's model. */
let providerFactory: ChatProviderFactory | undefined;

export function setChatProviderFactory(factory: ChatProviderFactory): void {
  providerFactory = factory;
}

export class ChatNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatNotFoundError';
  }
}

export interface SendChatInput {
  userId: string;
  conversationId?: string | undefined;
  content: string;
  modelKey: string;
  idempotencyKey: string;
}

export interface SendChatResult {
  conversationId: string;
  messageId: string;
  runId: string;
  meta?: { degraded?: { reason: 'NO_KEY' | 'QUOTA_EXCEEDED'; from: string } | undefined } | undefined;
}

async function appendEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await prisma.runEvent.create({
    data: {
      runId,
      seq: nextSeq(runId),
      type,
      payload: payload as Prisma.InputJsonValue,
      // createdAt 是默认值，但信封要求 time；写一致时间戳便于回放。
    },
  });
}

/**
 * 发送消息并在当前请求线程内完成流式执行（M1 简化版）。
 * - 幂等：同 (ownerId, idempotencyKey) 返回已有 run。
 * - 全程逐条写 RunEvent，seq 由模块级计数器保证严格递增。
 */
export async function sendChat(input: SendChatInput): Promise<SendChatResult> {
  const { userId, content, modelKey, idempotencyKey } = input;
  const useWorker = process.env.EXECUTION_MODE === 'worker';

  // 幂等重放：先查已有 run，直接返回（含首次创建时记录的 userMessageId）。
  const existing = await prisma.orchestrationRun.findUnique({
    where: { ownerId_idempotencyKey: { ownerId: userId, idempotencyKey } },
  });
  if (existing) {
    const snapshot = (existing.configSnapshot ?? {}) as { userMessageId?: string; meta?: SendChatResult['meta'] };
    return {
      conversationId: existing.conversationId,
      messageId: snapshot.userMessageId ?? '',
      runId: existing.id,
      ...(snapshot.meta ? { meta: snapshot.meta } : {}),
    };
  }

  // 会话：有 id 则校验所有权（非本人按 404 处理），无则自动建 SINGLE。
  let conversationId = input.conversationId;
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv || conv.ownerId !== userId) {
      throw new ChatNotFoundError('conversation not found');
    }
  } else {
    const conv = await createConversation(
      prisma,
      userId,
      content.slice(0, 40) || 'New chat',
      'SINGLE',
    );
    conversationId = conv.id;
  }

  const resolved = providerFactory ? undefined : await resolver.resolve(userId, modelKey);
  // Persist reproducible model metadata, never the decrypted API key.
  const resolvedSnapshot = resolved ? (({ apiKey: _apiKey, ...snapshot }) => snapshot)(resolved) : undefined;
  const meta = resolved?.degraded ? { degraded: resolved.degraded } : undefined;
  const rag = await retrieveContext(userId, conversationId, content);
  const degradationReasons = [
    ...(meta?.degraded ? [meta.degraded.reason] : []),
    ...(rag.status === 'RAG_UNAVAILABLE' ? ['RAG_UNAVAILABLE'] : []),
  ];
  const userMessage = await createMessage(prisma, conversationId, content);

  let run;
  try {
    run = await prisma.orchestrationRun.create({
      data: {
        conversationId,
        ownerId: userId,
        // attempt=0 的 RUNNING 专属 inline；worker 只恢复已经领取过的 run。
        status: useWorker ? 'PENDING' : 'RUNNING',
        degraded: degradationReasons.length > 0,
        ...(degradationReasons.length ? { degradationReasons } : {}),
        idempotencyKey,
        participantSnapshots: {
          create: {
            seatId: 'default', providerKey: resolved?.adapter ?? 'test',
            modelKey: resolved?.modelId ?? modelKey, systemPrompt: '', params: {}, pricingVersion: 'registry',
          },
        },
        configSnapshot: {
          modelKey,
          content,
          rag,
          ...(resolvedSnapshot ? { resolved: resolvedSnapshot } : {}),
          ...(meta ? { meta } : {}),
          contentLength: content.length,
          userMessageId: userMessage.id,
        },
      },
    });
  } catch (err) {
    // 并发同 idempotencyKey：唯一约束冲突 → 返回已有 run。
    if (isUniqueViolation(err)) {
      const raced = await prisma.orchestrationRun.findUnique({
        where: { ownerId_idempotencyKey: { ownerId: userId, idempotencyKey } },
      });
      if (raced) {
        const snapshot = (raced.configSnapshot ?? {}) as { userMessageId?: string; meta?: SendChatResult['meta'] };
        return {
          conversationId: raced.conversationId,
          messageId: snapshot.userMessageId ?? '',
          runId: raced.id,
          ...(snapshot.meta ? { meta: snapshot.meta } : {}),
        };
      }
    }
    throw err;
  }
  const runId = run.id;

  // M2 outbox 模式：API 只写命令（run=PENDING），执行交给 worker。
  // 过渡期：EXECUTION_MODE!=worker 时 setImmediate 内联执行保持 M1 行为。
  if (!useWorker) {
    setImmediate(() => {
      executeRunInline(runId, conversationId, content, modelKey, userId, rag,
        (run.configSnapshot ?? {}) as { resolved?: Omit<ResolvedModel, 'apiKey'> }, resolved?.apiKey).catch(() => {});
    });
  }
  return { conversationId, messageId: userMessage.id, runId, ...(meta ? { meta } : {}) };
}

/** M1 兼容的内联执行（worker 就绪后由 apps/worker 的 processRun 接管）。 */
async function executeRunInline(
  runId: string,
  conversationId: string,
  content: string,
  modelKey: string,
  userId: string,
  rag: RagSnapshot,
  configSnapshot: { resolved?: Omit<ResolvedModel, 'apiKey'> },
  apiKey?: string,
): Promise<void> {
  // 保险：若 worker 已抢先领走该 run（leaseOwner 非空），inline 路径直接退出，避免双执行。
  const leased = await prisma.orchestrationRun.findUnique({
    where: { id: runId },
    select: { leaseOwner: true },
  });
  if (leased?.leaseOwner) return;

  const controller = new AbortController();
  abortControllers.set(runId, controller);

  try {
    // stop 可能先于启动到达（PENDING 窗口）：cancelRequested 已置位则直接取消。
    const early = await prisma.orchestrationRun.findUnique({
      where: { id: runId },
      select: { cancelRequested: true },
    });
    if (early?.cancelRequested) throw new AbortedError();

    await appendEvent(runId, 'run.started', { modelKey });

    const resolved = configSnapshot.resolved ? { ...configSnapshot.resolved, apiKey: apiKey ?? '' } : undefined;
    const degradationReasons = new Set<string>(resolved?.degraded ? [resolved.degraded.reason] : []);
    const provider = providerFactory ? providerFactory(modelKey) : quotaProvider(prisma, {
      userId, runId, modelId: modelKey, initial: resolved, reuseInitial: true, attempt: 0, seatId: 'default', invocation: 0,
      onResolved: async model => {
        if (model.degraded) {
          degradationReasons.add(model.degraded.reason);
          await appendEvent(runId, 'run.degraded', { degraded: model.degraded });
          await prisma.orchestrationRun.update({ where: { id: runId }, data: {
            degraded: true, degradationReasons: [...degradationReasons],
          } });
        }
      },
    });
    const currentRag = await revalidateContext(userId, conversationId, rag);
    if (currentRag.status === 'RAG_UNAVAILABLE') {
      degradationReasons.add('RAG_UNAVAILABLE');
      await appendEvent(runId, 'run.degraded', { reason: 'RAG_UNAVAILABLE' });
      await prisma.orchestrationRun.update({ where: { id: runId }, data: {
        degraded: true, degradationReasons: [...degradationReasons],
      } });
    }
    const prompt = injectContext([{ role: 'user', content }], currentRag.hits, provider.capabilities());
    let text = '';
    let finishReason = 'stop';
    let tokensIn = 0;
    let tokensOut = 0;
    for await (const ev of provider.streamChat(
      prompt.messages,
      { signal: controller.signal, maxTokens: prompt.maxTokens },
    )) {
      if (ev.type === 'text-delta') {
        text += ev.delta;
        await appendEvent(runId, 'provider.delta', { delta: ev.delta });
        if (text.length % 5 === 0) {
          const row = await prisma.orchestrationRun.findUnique({
            where: { id: runId },
            select: { cancelRequested: true },
          });
          if (row?.cancelRequested) controller.abort();
        }
      } else if (ev.type === 'usage') {
        tokensIn = ev.usage.promptTokens;
        tokensOut = ev.usage.completionTokens;
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      } else if (ev.type === 'done') {
        finishReason = ev.finishReason;
      }
    }

    if (controller.signal.aborted || finishReason === 'cancelled') {
      throw new AbortedError();
    }

    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    await prisma.$transaction(async (tx) => {
      if (providerFactory) {
      const participant = await tx.runParticipantSnapshot.findFirst({
        where: { runId, seatId: 'default' }, select: { id: true },
      });
      const call = await tx.providerCall.create({
        data: {
          runId, attempt: 0, requestHash: `inline:${runId}`,
          ...(participant ? { participantSnapshotId: participant.id } : {}),
          usage: { promptTokens: tokensIn, completionTokens: tokensOut }, endedAt: new Date(),
        },
      });
      await tx.modelUsageDaily.upsert({
        where: { userId_modelId_date: { userId, modelId: resolved?.modelId ?? modelKey, date } },
        create: { userId, modelId: resolved?.modelId ?? modelKey, date, tokensIn, tokensOut },
        update: { tokensIn: { increment: tokensIn }, tokensOut: { increment: tokensOut } },
      });
      await tx.usageLog.create({ data: { userId, runId, callId: call.id, tokens: tokensIn + tokensOut, costMicros: 0n } });
      }
      await tx.message.create({ data: { conversationId, content: text, status: 'COMPLETE', citations: prompt.citations } });
      await tx.orchestrationRun.update({
        where: { id: runId },
        data: { status: 'SUCCEEDED', ...(degradationReasons.size ? {
          degraded: true, degradationReasons: [...degradationReasons],
        } : {}) },
      });
    });
    await appendEvent(runId, 'run.succeeded', { citations: prompt.citations });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const status = aborted ? 'CANCELLED' : 'FAILED';
    // 先落终态再写事件：若事件写入失败，run 也不会滞留 RUNNING。
    await prisma.orchestrationRun
      .update({ where: { id: runId }, data: { status } })
      .catch(() => {});
    if (aborted) {
      await appendEvent(runId, 'run.cancelled', {}).catch(() => {});
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await appendEvent(runId, 'run.failed', { error: message }).catch(() => {});
    }
  } finally {
    abortControllers.delete(runId);
    seqCounters.delete(runId);
  }
}

class AbortedError extends Error {
  constructor() {
    super('run aborted');
    this.name = 'AbortedError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/** 停止进行中的 run（幂等：run 不存在/非本人 → 404；无控制器也返回 ok）。 */
export async function stopChat(params: { userId: string; runId: string }): Promise<{ ok: true }> {
  const run = await prisma.orchestrationRun.findUnique({ where: { id: params.runId } });
  if (!run || run.ownerId !== params.userId) {
    throw new ChatNotFoundError('run not found');
  }
  abortControllers.get(params.runId)?.abort();
  await prisma.orchestrationRun.update({
    where: { id: params.runId },
    data: { cancelRequested: true },
  }).catch(() => {});
  return { ok: true };
}
