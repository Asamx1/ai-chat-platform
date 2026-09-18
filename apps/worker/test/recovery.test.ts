/**
 * M2 故障恢复自动化测试（PLAN §12-M2 出口：进程终止后恢复，不重复记账）。
 * 不依赖真实进程 kill：用「processRun 中途丢弃 lease/进程模拟」验证状态机。
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

const { prisma } = await import('@aichat/db');
const { claimNextRun, renewLease, releaseLease } = await import('../src/lease');
const { processRun } = await import('../src/runner');
const { FakeProvider } = await import('@aichat/providers');

let userId: string;
const createdRuns: string[] = [];

beforeAll(async () => {
  const u = await prisma.user.upsert({
    where: { email: 'm2-recovery-test@local' },
    update: {},
    create: { email: 'm2-recovery-test@local', passwordHash: 'x' },
  });
  userId = u.id;
});

afterAll(async () => {
  await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function makeRun(idem: string): Promise<string> {
  const c = await prisma.conversation.create({
    data: { ownerId: userId, title: 'recovery', type: 'SINGLE' },
  });
  const m = await prisma.message.create({
    data: { conversationId: c.id, content: 'recover me', status: 'PENDING' },
  });
  const r = await prisma.orchestrationRun.create({
    data: {
      conversationId: c.id,
      ownerId: userId,
      status: 'PENDING',
      idempotencyKey: idem,
      configSnapshot: { modelKey: 'fake-test', content: 'recover me', userMessageId: m.id },
    },
  });
  createdRuns.push(r.id);
  return r.id;
}

// 全局队列表共享：用例前清空无关可领 run，保证 claim 领到的是本用例造的。
async function drainQueue(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status='PENDING' OR (status='RUNNING' AND "leaseExpiresAt" < now() + interval '5 seconds')`,
  );
}


describe('durable run recovery', () => {
  it('claims, "dies" (lease expires), second worker takes over and completes', async () => {
    await drainQueue();
    const runId = await makeRun(`recovery-${Date.now()}-1`);

    // worker1 领取
    const claimed1 = await claimNextRun('w-recovery-1');
    expect(claimed1).toBe(runId);
    let run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('RUNNING');
    expect(run?.leaseOwner).toBe('w-recovery-1');
    expect(run?.attempt).toBe(1);

    // 模拟 worker1 死亡：不等续租，直接把 lease 拨过期（等价 30s TTL 走完）
    await prisma.$executeRawUnsafe(
      `UPDATE "OrchestrationRun" SET "leaseExpiresAt" = now() - interval '1 second' WHERE id = $1`,
      runId,
    );

    // worker2 领取（lease 过期的 RUNNING 可被接管）
    const claimed2 = await claimNextRun('w-recovery-2');
    expect(claimed2).toBe(runId);
    run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.leaseOwner).toBe('w-recovery-2');
    expect(run?.attempt).toBe(2); // attempt 递增（恢复重试）

    // 旧 worker 的续租被拒（丢租检测）
    const renewed = await renewLease(runId, 'w-recovery-1');
    expect(renewed).toBe(0);

    // worker2 完成执行（注入 fake provider，同步跑完）
    await processRun(runId, 'w-recovery-2', {
      providerFactory: () => new FakeProvider(['recovered answer']),
    });

    run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('SUCCEEDED');
    expect(run?.leaseOwner).toBe(null); // 释放

    const events = await prisma.runEvent.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.succeeded');
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // seq 严格不重复

    // 幂等记账：UsageLog 对该 run 恰好一条
    const usage = await prisma.usageLog.findMany({ where: { runId } });
    expect(usage.length).toBe(1);
    // ProviderCall requestHash 唯一
    const calls = await prisma.providerCall.findMany({ where: { runId } });
    expect(calls.length).toBe(1);
  }, 30_000);

  it('second claim of fresh PENDING run goes to a different run (SKIP LOCKED semantics)', async () => {
    await drainQueue();
    const r1 = await makeRun(`recovery-${Date.now()}-2a`);
    const r2 = await makeRun(`recovery-${Date.now()}-2b`);
    const c1 = await claimNextRun('w-a');
    const c2 = await claimNextRun('w-b');
    expect(new Set([c1, c2]).size).toBe(2);
    expect([r1, r2]).toContain(c1);
    expect([r1, r2]).toContain(c2);
    // 清理：置 CANCELLED 防止干扰
    await prisma.orchestrationRun.updateMany({
      where: { id: { in: [r1, r2] } },
      data: { status: 'CANCELLED', leaseOwner: null },
    });
    await releaseLease(c1!, 'w-a');
    await releaseLease(c2!, 'w-b');
  });
});
