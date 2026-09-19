/**
 * M7: 协作条件 executor —— 把 batch-runner 的 Task 接到 M4 orchestrator 管线。
 * 进程内直跑 processCollabRun（同 debate-e2e 模式）：CONSENSUS/DEBATE 条件复用整个 durable run 基础设施
 * （事件、记账、匿名、洗牌、裁判、降级），实验侧只做 manifest→run 造数 + 结果抽取。
 */
import { config } from 'dotenv';

config();

const { prisma } = await import('@aichat/db');
const { processCollabRun } = await import('../../apps/worker/src/collab-runner');

export interface CollabSpec {
  mode: 'CONSENSUS' | 'DEBATE';
  /** 席位定义（seatId/modelKey/role/systemPrompt） */
  seats: Array<{ seatId: string; modelKey: string; role: string; systemPrompt: string }>;
  maxRounds?: number;
}

/** 执行一次协作任务；返回最终消息文本（裁判结论/共识汇总）与聚合 usage。 */
export async function runCollab(spec: CollabSpec, question: string, tag: string): Promise<{
  text: string;
  promptTokens: number;
  completionTokens: number;
  runId: string;
  degraded: boolean;
}> {
  const email = `m7-${tag}@local`;
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash: 'x' } });
  const conv = await prisma.conversation.create({
    data: { ownerId: user.id, title: `m7-${tag}`, type: spec.mode },
  });
  const msg = await prisma.message.create({
    data: { conversationId: conv.id, content: question, status: 'PENDING' },
  });
  const run = await prisma.orchestrationRun.create({
    data: {
      conversationId: conv.id,
      ownerId: user.id,
      status: 'RUNNING',
      leaseOwner: `m7-${tag}`,
      leaseExpiresAt: new Date(Date.now() + 300_000),
      idempotencyKey: `m7-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      configSnapshot: {
        mode: spec.mode, content: question, userMessageId: msg.id,
        seats: spec.seats, maxRounds: spec.maxRounds ?? 1,
      },
    },
  });
  for (const s of spec.seats) {
    await prisma.runParticipantSnapshot.create({
      data: {
        runId: run.id, seatId: s.seatId, providerKey: 'ollama',
        modelKey: s.modelKey, systemPrompt: s.systemPrompt,
        params: { role: s.role }, pricingVersion: 'local-0',
      },
    });
  }
  await processCollabRun(run.id, `m7-${tag}`);
  // 终态读取
  const final = await prisma.orchestrationRun.findUnique({ where: { id: run.id } });
  if (final?.status !== 'SUCCEEDED') {
    const errEv = await prisma.runEvent.findFirst({
      where: { runId: run.id, type: 'run.failed' },
      orderBy: { seq: 'desc' },
    });
    throw new Error(`collab run ${final?.status}: ${errEv?.payload ? JSON.stringify(errEv.payload).slice(0, 200) : 'n/a'}`);
  }
  const finalMsg = await prisma.message.findFirst({
    where: { conversationId: conv.id, status: 'COMPLETE' },
    orderBy: { createdAt: 'desc' },
  });
  const usage = await prisma.usageLog.aggregate({
    where: { runId: run.id },
    _sum: { tokens: true },
  });
  // 清理实验痕迹（保留 events/run 数据供审计：只删会话壳）
  return {
    text: finalMsg?.content ?? '',
    promptTokens: 0,
    completionTokens: usage._sum.tokens ?? 0,
    runId: run.id,
    degraded: Boolean(final.degraded),
  };
}

export { prisma };
