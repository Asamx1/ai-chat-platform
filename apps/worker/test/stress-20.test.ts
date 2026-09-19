/**
 * M3 GPU 队列 20 并发压测（PLAN M3 出口：20 并发本地请求无 OOM，记录 p50/p95 等待）。
 * 方案（E5 测试计划 §四）：不真打 20 个 Ollama 请求（本地 0.6b 串行也会排队），
 * 而是压测「claim 队列 + worker 执行管线」：20 个 PENDING run 同时可领，
 * 单 worker 顺序消费，断言：全部到终态、无重复领取、无重复记账、耗时分布。
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

const { prisma } = await import('@aichat/db');
const { claimNextRun } = await import('../src/lease');
const { processCollabRun } = await import('../src/collab-runner');
const { FakeProvider } = await import('@aichat/providers');

const N = 20;
let userId: string;
let convId: string;
const runIds: string[] = [];
const claimTimes = new Map<string, number>();
const doneTimes = new Map<string, number>();
const t0 = Date.now();

beforeAll(async () => {
  const u = await prisma.user.upsert({
    where: { email: 'm3-stress@local' },
    update: {},
    create: { email: 'm3-stress@local', passwordHash: 'x' },
  });
  userId = u.id;
  const c = await prisma.conversation.create({
    data: { ownerId: userId, title: 'stress', type: 'SINGLE' },
  });
  convId = c.id;
  // 清理历史同用户 runs
  await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
  // 造 20 个单席 PENDING（走 processRun 回落路径，provider 注入 fake）
  for (let i = 0; i < N; i++) {
    const m = await prisma.message.create({
      data: { conversationId: convId, content: `stress-${i}`, status: 'PENDING' },
    });
    const r = await prisma.orchestrationRun.create({
      data: {
        conversationId: convId,
        ownerId: userId,
        status: 'PENDING',
        idempotencyKey: `stress-${Date.now()}-${i}`,
        configSnapshot: { modelKey: 'fake-stress', content: `stress-${i}`, userMessageId: m.id },
      },
    });
    runIds.push(r.id);
  }
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status IN ('PENDING','FAILED') OR (status='RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now() + interval '5 seconds'))`);
  // afterAllDrain
  await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('GPU queue: 20 concurrent claims, single worker drain', () => {
  it('all 20 runs reach terminal state, no dup claims, exactly-once accounting', async () => {
    // 造数挪进用例：先 drain 全局队列，再建 20 个（消除与上一文件 afterAll drain 的时序耦合）
    await prisma.$executeRawUnsafe(
      `UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status IN ('PENDING','FAILED') OR (status='RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now() + interval '5 seconds'))`,
    );
    runIds.length = 0;
    for (let i = 0; i < N; i++) {
      const m = await prisma.message.create({
        data: { conversationId: convId, content: `stress-${Date.now()}-${i}`, status: 'PENDING' },
      });
      const r = await prisma.orchestrationRun.create({
        data: {
          conversationId: convId,
          ownerId: userId,
          status: 'PENDING',
          idempotencyKey: `stress-${Date.now()}-${i}`,
          configSnapshot: { modelKey: 'fake-stress', content: `stress-${i}`, userMessageId: m.id },
        },
      });
      runIds.push(r.id);
    }

    // 并发领取（多 worker 抢）+ 单 worker 逐个执行（模拟 GPU 串行约束）
    const claimed = new Set<string>();
    const execute = async (workerId: string) => {
      for (;;) {
        const runId = await claimNextRun(workerId);
        if (!runId) return;
        expect(claimed.has(runId)).toBe(false); // 无重复领取
        claimed.add(runId);
        claimTimes.set(runId, Date.now() - t0);
        await processCollabRun(runId, workerId, {
          providerFactory: (modelKey) =>
            new FakeProvider([`answer-for-${modelKey}`], { perTokenDelayMs: 5 }),
        });
        doneTimes.set(runId, Date.now() - t0);
      }
    };
    // 2 个并发 claim worker（队列消费端），顺序执行保证 GPU 串行
    await Promise.all([execute('stress-w1'), execute('stress-w2')]);

    if (claimed.size !== N) {
      const rows = await prisma.orchestrationRun.findMany({
        where: { id: { in: runIds } },
        select: { id: true, status: true, leaseOwner: true, attempt: true },
      });
      const missing = runIds.filter((id) => !claimed.has(id));
      console.log(
        '[stress-diag] claimed:',
        claimed.size,
        '| missing runs:',
        JSON.stringify(rows.filter((r) => missing.includes(r.id))),
      );
    }
    expect(claimed.size).toBe(N);
    for (const id of runIds) {
      const r = await prisma.orchestrationRun.findUnique({ where: { id } });
      expect(r?.status).toBe('SUCCEEDED');
    }
    // 记账恰好一次
    const calls = await prisma.providerCall.findMany({ where: { runId: { in: runIds } } });
    expect(calls.length).toBe(N);

    // 等待分布报告
    const waits = runIds.map((id) => (claimTimes.get(id) ?? 0));
    const sorted = [...waits].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(N * 0.5)];
    const p95 = sorted[Math.floor(N * 0.95)];
    console.log(
      `[stress] claim wait ms — p50=${p50} p95=${p95} max=${sorted[N - 1]} total=${Date.now() - t0}`,
    );
  }, 120_000);
});
