/**
 * M2 出口自动化故障注入矩阵（PLAN §12-M2）。
 * 对 run 生命周期的 5 个阶段分别注入故障，验证：
 *   ① started 前（lease 过期被接管） ② delta 流中（provider 流 reject）
 *   ③ checkpoint 已写（断言存在且 version>0，可续跑） ④ usage 已记（UsageLog 唯一）
 *   ⑤ 终态后（重复 processRun 幂等，不产生第二个 succeeded）
 * 每用例统一断言：seq 无重复、UsageLog 无重复、终态一致（SUCCEEDED 或安全 FAILED）。
 * 慢流：FakeProvider perTokenDelayMs=50、40 个 token（≈2s），给故障注入留时间窗。
 */
import { config } from 'dotenv';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ChatMessage, ProviderAdapter, ProviderStreamEvent, StreamChatOptions } from '@aichat/providers';

config();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');

const { prisma } = await import('@aichat/db');
const { claimNextRun } = await import('../src/lease');
const { processRun } = await import('../src/runner');
const { FakeProvider } = await import('@aichat/providers');

// 40 token 的单条脚本（FakeProvider 按空白切 token → 40 个 text-delta）。
const SLOW_SCRIPT = Array.from({ length: 40 }, (_, i) => `tok${i}`).join(' ');
const TOKEN_DELAY_MS = 50;

function slowFake(): FakeProvider {
  return new FakeProvider([SLOW_SCRIPT], { perTokenDelayMs: TOKEN_DELAY_MS });
}

/** 故障注入：透传内部 provider，但在第 N 个 text-delta 之后 reject（模拟流中崩溃）。 */
class CrashAfterNDeltas implements ProviderAdapter {
  constructor(private readonly inner: ProviderAdapter, private readonly n: number) {}

  capabilities() {
    return this.inner.capabilities();
  }

  async *streamChat(
    messages: ChatMessage[],
    opts?: StreamChatOptions,
  ): AsyncIterable<ProviderStreamEvent> {
    let seen = 0;
    for await (const ev of this.inner.streamChat(messages, opts)) {
      if (ev.type === 'text-delta') seen += 1;
      if (seen > this.n) throw new Error(`injected crash after ${this.n} deltas`);
      yield ev;
    }
  }
}

let userId: string;

beforeAll(async () => {
  const u = await prisma.user.upsert({
    where: { email: 'm2-fault-matrix-test@local' },
    update: {},
    create: { email: 'm2-fault-matrix-test@local', passwordHash: 'x' },
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
    data: { ownerId: userId, title: 'fault-matrix', type: 'SINGLE' },
  });
  const m = await prisma.message.create({
    data: { conversationId: c.id, content: 'fault me', status: 'PENDING' },
  });
  const r = await prisma.orchestrationRun.create({
    data: {
      conversationId: c.id,
      ownerId: userId,
      status: 'PENDING',
      idempotencyKey: idem,
      configSnapshot: { modelKey: 'fake-test', content: 'fault me', userMessageId: m.id },
    },
  });
  return r.id;
}

// 全局队列表共享：用例前清空无关可领 run，保证 claim 领到的是本用例造的。
async function drainQueue(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status IN ('PENDING','FAILED') OR (status='RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now() + interval '5 seconds'))`,
  );
}

/** 直接把 lease 拨过期（等价 30s TTL 走完）。 */
async function expireLease(runId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun" SET "leaseExpiresAt" = now() - interval '1 second', "leaseOwner" = NULL WHERE id = $1`,
    runId,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 每用例统一不变量：seq 唯一、UsageLog ≤1（终态后应为 1）、run 处于一致终态且已释放租约。 */
async function expectInvariants(runId: string, terminal: 'SUCCEEDED' | 'FAILED') {
  const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
  expect(run?.status, `final status (${terminal})`).toBe(terminal);
  expect(run?.leaseOwner, 'lease released').toBe(null);

  const events = await prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
  const seqs = events.map((e) => e.seq);
  expect(new Set(seqs).size, 'seq 严格不重复').toBe(seqs.length);

  const usage = await prisma.usageLog.findMany({ where: { runId } });
  expect(usage.length, 'UsageLog 无重复').toBeLessThanOrEqual(1);

  const types = events.map((e) => e.type);
  return { events, types, usage };
}

describe('M2 fault-injection matrix (5 lifecycle stages)', () => {
  it('① before started: fresh PENDING, lease expired, second worker takes over to terminal', async () => {
    await drainQueue();
    const runId = await makeRun(`fault-${Date.now()}-1`);

    // worker1 领取（尚无任何事件 = started 前）
    const claimed1 = await claimNextRun('w-fault-1a');
    expect(claimed1).toBe(runId);
    expect(
      await prisma.runEvent.count({ where: { runId } }),
    ).toBe(0);

    // 故障：worker1 领取后、开始执行前 lease 过期
    await expireLease(runId);

    // worker2 接管并执行到终态
    const claimed2 = await claimNextRun('w-fault-1b');
    expect(claimed2).toBe(runId);
    const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.attempt).toBe(2);

    await processRun(runId, 'w-fault-1b', { providerFactory: () => slowFake() });

    const { types, usage } = await expectInvariants(runId, 'SUCCEEDED');
    expect(types.filter((t) => t === 'run.started')).toHaveLength(1); // 只有接管者写了 started
    expect(types.at(-1)).toBe('run.succeeded');
    expect(usage.length).toBe(1);
  }, 30_000);

  it('② mid-delta-stream: provider rejects after ~10 deltas (≈500ms) → safe FAILED, no double accounting', async () => {
    await drainQueue();
    const runId = await makeRun(`fault-${Date.now()}-2`);
    const claimed = await claimNextRun('w-fault-2');
    expect(claimed).toBe(runId);

    await processRun(runId, 'w-fault-2', {
      providerFactory: () => new CrashAfterNDeltas(slowFake(), 10),
    });

    const { types, usage } = await expectInvariants(runId, 'FAILED');
    expect(types.at(-1)).toBe('run.failed'); // 安全失败：显式 run.failed 事件收尾
    expect(types).not.toContain('run.succeeded');
    expect(usage.length).toBe(0); // 流未完成 → 未记账
  }, 30_000);

  it('③ checkpoint written: takeover mid-stream leaves checkpoint (version>0) and second worker resumes to SUCCEEDED', async () => {
    await drainQueue();
    const runId = await makeRun(`fault-${Date.now()}-3`);
    const claimed1 = await claimNextRun('w-fault-3a');
    expect(claimed1).toBe(runId);

    // worker1 开始慢流（心跳调快以尽快发现丢租）
    const p1 = processRun(runId, 'w-fault-3a', {
      providerFactory: () => slowFake(),
      renewIntervalMs: 100,
    });

    // 等 ~1.3s：≥20 个 delta 已过 → checkpoint 已落盘（CHECKPOINT_EVERY_DELTAS=20）
    await sleep(1_300);
    await expireLease(runId);
    const claimed2 = await claimNextRun('w-fault-3b'); // worker2 接管 → worker1 心跳续租失败 → 静默退出
    expect(claimed2).toBe(runId);
    await p1;

    const cp = await prisma.runCheckpoint.findFirst({
      where: { runId },
      orderBy: { version: 'desc' },
    });
    expect(cp, 'RunCheckpoint 存在').toBeTruthy();
    expect(cp!.version).toBeGreaterThan(0);
    expect((cp!.stateJson as { accumulated?: string }).accumulated.length).toBeGreaterThan(0);
    expect(
      (await prisma.runEvent.findMany({ where: { runId } })).some((e) => e.type === 'run.succeeded'),
    ).toBe(false); // 接管瞬间尚未终态

    // worker2 从 checkpoint 续跑到终态
    await processRun(runId, 'w-fault-3b', { providerFactory: () => slowFake() });

    const { types, usage } = await expectInvariants(runId, 'SUCCEEDED');
    expect(types[0]).toBe('run.started');
    expect(types.filter((t) => t === 'run.started')).toHaveLength(1); // resume 不重写 started
    expect(types.at(-1)).toBe('run.succeeded');
    expect(usage.length).toBe(1);
    const calls = await prisma.providerCall.findMany({ where: { runId } });
    expect(calls.length).toBe(1); // requestHash 幂等：重放不双计
  }, 30_000);

  it('④ usage recorded: successful run has exactly one UsageLog / ProviderCall', async () => {
    await drainQueue();
    const runId = await makeRun(`fault-${Date.now()}-4`);
    const claimed = await claimNextRun('w-fault-4');
    expect(claimed).toBe(runId);

    await processRun(runId, 'w-fault-4', { providerFactory: () => slowFake() });

    const { usage } = await expectInvariants(runId, 'SUCCEEDED');
    expect(usage.length).toBe(1);
    expect(usage[0]!.tokens).toBeGreaterThan(0);
    const calls = await prisma.providerCall.findMany({ where: { runId } });
    expect(calls.length).toBe(1);
  }, 30_000);

  it('⑤ after terminal: repeated processRun is idempotent — no second run.succeeded', async () => {
    await drainQueue();
    const runId = await makeRun(`fault-${Date.now()}-5`);
    const claimed = await claimNextRun('w-fault-5a');
    expect(claimed).toBe(runId);
    await processRun(runId, 'w-fault-5a', { providerFactory: () => slowFake() });
    expect((await prisma.orchestrationRun.findUnique({ where: { id: runId } }))?.status).toBe('SUCCEEDED');

    // 故障：终态后重复投递（网络重试 / 编排器重放）
    await processRun(runId, 'w-fault-5a', { providerFactory: () => slowFake() });

    const { types } = await expectInvariants(runId, 'SUCCEEDED');
    expect(types.filter((t) => t === 'run.succeeded')).toHaveLength(1); // 幂等：不产生第二个 succeeded
    expect(types.filter((t) => t === 'run.started')).toHaveLength(1);
    const usage = await prisma.usageLog.findMany({ where: { runId } });
    expect(usage.length).toBe(1);
  }, 30_000);
});
