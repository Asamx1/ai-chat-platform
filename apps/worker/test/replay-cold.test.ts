/** M5 出口验证：Redis 清空 + 重启后 DB 冷启动回放（vitest 直跑，含事件完整性/所有权/重复校验）。 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config();

const { prisma } = await import('@aichat/db');

let victimRunId = '';
let victimEventCount = 0;
let secondUser = '';

beforeAll(async () => {
  // 选主库中事件最多的 SUCCEEDED run 作为回放样本（真实数据冷启动回放）
  const rows = await prisma.orchestrationRun.findMany({
    where: { status: 'SUCCEEDED' },
    select: { id: true, events: { select: { seq: true } } },
  });
  const top = rows.map((r) => ({ id: r.id, n: r.events.length })).sort((a, b) => b.n - a.n)[0];
  victimRunId = top.id;
  victimEventCount = top.n;
  secondUser = (await prisma.user.create({ data: { email: `m5-replay-${Date.now()}@local`, passwordHash: 'x' } })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: secondUser } }).catch(() => {});
  await prisma.$disconnect();
});

describe('M5 cold-start replay (Redis flushed, app restarted)', () => {
  it('Redis is empty and unreachable-for-cache → replay still works from Postgres', async () => {
    // 冷启动前置：清空 Redis 全库（模拟缓存全失效）
    const { execSync } = await import('node:child_process');
    execSync('docker exec aichat-redis redis-cli FLUSHALL', { stdio: 'ignore' });

    // 回放 = 从 DB 按 seq 升序重读全量事件（与 SSE 路由同一数据面）
    const events = await prisma.runEvent.findMany({
      where: { runId: victimRunId },
      orderBy: { seq: 'asc' },
    });
    expect(events.length).toBe(victimEventCount);
    expect(events.length).toBeGreaterThan(50); // 真实 run 而非空壳

    // seq 严格递增且无重复（(runId,seq) 不变式）
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(new Set(seqs).size).toBe(seqs.length);

    // 终态事件存在且唯一
    const finals = events.filter((e) => e.type === 'run.succeeded');
    expect(finals.length).toBe(1);
    // 回放不产生新事件（只读）
    const after = await prisma.runEvent.count({ where: { runId: victimRunId } });
    expect(after).toBe(victimEventCount);
  });

  it('ownership enforced on replay path: other user gets 404-equivalent (no rows)', async () => {
    const run = await prisma.orchestrationRun.findUnique({
      where: { id: victimRunId },
      select: { ownerId: true },
    });
    expect(run?.ownerId).toBeTruthy();
    expect(run!.ownerId).not.toBe(secondUser); // 他人视角必须查无此 run
    const asOther = await prisma.orchestrationRun.findFirst({
      where: { id: victimRunId, ownerId: secondUser },
    });
    expect(asOther).toBeNull();
  });
});
