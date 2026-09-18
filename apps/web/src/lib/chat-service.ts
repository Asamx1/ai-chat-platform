import { prisma } from '@aichat/db';
import type { Prisma } from '@aichat/db';
import {
  createConversation,
  createMessage,
  updateMessageStatus,
} from '@aichat/db';
import { OllamaProvider } from '@aichat/providers';
import type { ProviderAdapter } from '@aichat/providers';

/** M1：同进程流式执行。runId → AbortController / seq 计数器（模块级）。 */
const abortControllers = new Map<string, AbortController>();
const seqCounters = new Map<string, number>();

function nextSeq(runId: string): number {
  const seq = seqCounters.get(runId) ?? 0;
  seqCounters.set(runId, seq + 1);
  return seq;
}

export type ChatProviderFactory = (modelKey: string) => ProviderAdapter;

/** 默认走本机 Ollama；测试可覆盖。 */
let providerFactory: ChatProviderFactory = (modelKey) =>
  new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', model: modelKey });

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

  // 幂等重放：先查已有 run，直接返回（含首次创建时记录的 userMessageId）。
  const existing = await prisma.orchestrationRun.findUnique({
    where: { ownerId_idempotencyKey: { ownerId: userId, idempotencyKey } },
  });
  if (existing) {
    const snapshot = (existing.configSnapshot ?? {}) as { userMessageId?: string };
    return {
      conversationId: existing.conversationId,
      messageId: snapshot.userMessageId ?? '',
      runId: existing.id,
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

  const userMessage = await createMessage(prisma, conversationId, content);

  let run;
  try {
    run = await prisma.orchestrationRun.create({
      data: {
        conversationId,
        ownerId: userId,
        status: 'RUNNING',
        idempotencyKey,
        configSnapshot: {
          modelKey,
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
        const snapshot = (raced.configSnapshot ?? {}) as { userMessageId?: string };
        return {
          conversationId: raced.conversationId,
          messageId: snapshot.userMessageId ?? '',
          runId: raced.id,
        };
      }
    }
    throw err;
  }
  const runId = run.id;

  // M2 outbox 模式：API 只写命令（run=PENDING），执行交给 worker。
  // 过渡期：EXECUTION_MODE!=worker 时 setImmediate 内联执行保持 M1 行为。
  if (process.env.EXECUTION_MODE !== 'worker') {
    setImmediate(() => {
      executeRunInline(runId, conversationId, content, modelKey).catch(() => {});
    });
  }
  return { conversationId, messageId: userMessage.id, runId };
}

/** M1 兼容的内联执行（worker 就绪后由 apps/worker 的 processRun 接管）。 */
async function executeRunInline(
  runId: string,
  conversationId: string,
  content: string,
  modelKey: string,
): Promise<void> {
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

    const provider = providerFactory(modelKey);
    let text = '';
    let finishReason = 'stop';
    for await (const ev of provider.streamChat(
      [{ role: 'user', content }],
      { signal: controller.signal },
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
      } else if (ev.type === 'error') {
        throw new Error(ev.error);
      } else if (ev.type === 'done') {
        finishReason = ev.finishReason;
      }
    }

    if (controller.signal.aborted || finishReason === 'cancelled') {
      throw new AbortedError();
    }

    const assistant = await createMessage(prisma, conversationId, text);
    await updateMessageStatus(prisma, assistant.id, 'COMPLETE');
    await appendEvent(runId, 'run.succeeded', {});
    await prisma.orchestrationRun.update({
      where: { id: runId },
      data: { status: 'SUCCEEDED' },
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    if (aborted) {
      await appendEvent(runId, 'run.cancelled', {});
      await prisma.orchestrationRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED' },
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
