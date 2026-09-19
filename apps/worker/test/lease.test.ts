import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@aichat/db';
import { claimNextRun, renewLease, shouldCancel } from '../src/lease';

// 测试自建自清数据：user → conversation → runs（events/checkpoints 级联删除）。
let userId = '';
let conversationId = '';

async function createPendingRun(contentLength = 10): Promise<string> {
  const run = await prisma.orchestrationRun.create({
    data: {
      conversationId,
      ownerId: userId,
      status: 'PENDING',
      idempotencyKey: `lease-test-${crypto.randomUUID()}`,
      configSnapshot: { modelKey: 'fake', content: 'x'.repeat(contentLength) },
    },
  });
  return run.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `lease-test-${crypto.randomUUID()}@example.test`,
      passwordHash: 'x',
    },
  });
  userId = user.id;
  const conv = await prisma.conversation.create({
    data: { ownerId: userId, title: 'lease test', type: 'SINGLE' },
  });
  conversationId = conv.id;
});

afterAll(async () => {
  await drainQueue(); // afterAllDrain: 清理本文件遗留，防跨文件队列污染
  await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
  await prisma.conversation.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

// 全局队列表共享：用例前清空无关可领 run，保证 claim 领到的是本用例造的。
async function drainQueue(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status='PENDING' OR (status='RUNNING' AND "leaseExpiresAt" < now() + interval '5 seconds')`,
  );
}


describe('lease', () => {
  it('两个并发 claim 领到不同的 run（FOR UPDATE SKIP LOCKED）', async () => {
    await drainQueue();
    const idA = await createPendingRun();
    const idB = await createPendingRun();
    const [claimed1, claimed2] = await Promise.all([
      claimNextRun('worker-a'),
      claimNextRun('worker-b'),
    ]);
    expect(claimed1).not.toBeNull();
    expect(claimed2).not.toBeNull();
    expect(claimed1).not.toBe(claimed2);
    // 共享队列：只断言领到的是刚造的两个之一（不排除其他并行数据）。
    expect([idA, idB]).toContain(claimed1);
    expect([idA, idB, claimed1]).toContain(claimed2);

    const owners: string[] = [];
    for (const id of [claimed1!, claimed2!]) {
      const run = await prisma.orchestrationRun.findUniqueOrThrow({ where: { id } });
      expect(run.status).toBe('RUNNING');
      expect(run.attempt).toBe(1);
      expect(run.leaseExpiresAt).not.toBeNull();
      owners.push(run.leaseOwner ?? '');
    }
    expect(owners.sort()).toEqual(['worker-a', 'worker-b']);

    // 本测试造的两个 run 均已不在可领状态。
    const remain = await prisma.orchestrationRun.findMany({
      where: { id: { in: [idA, idB] }, status: 'PENDING' },
    });
    expect(remain.length).toBe(0);
  });

  it('renewLease 错误 workerId 返回 0（租约不属于自己）', async () => {
    await drainQueue();
    const id = await createPendingRun();
    const claimed = await claimNextRun('worker-a');
    expect(claimed).toBe(id);
    expect(await renewLease(id, 'worker-wrong')).toBe(0);
    expect(await renewLease(id, 'worker-a')).toBe(1);
  });

  it('shouldCancel 默认 false', async () => {
    await drainQueue();
    const id = await createPendingRun();
    expect(await shouldCancel(id)).toBe(false);
    await prisma.orchestrationRun.update({
      where: { id },
      data: { cancelRequested: true },
    });
    expect(await shouldCancel(id)).toBe(true);
  });
});
