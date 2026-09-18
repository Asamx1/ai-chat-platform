/**
 * chat-service 集成测试：直连 DATABASE_URL 的 Postgres 容器。
 * 注意：@aichat/db 在 import 时就要求 DATABASE_URL，因此先加载 .env
 * 再动态 import 被测模块（vitest 顶层 await 可用）。
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — chat-service tests need the Postgres container');
}

const { prisma } = await import('@aichat/db');
const { FakeProvider } = await import('@aichat/providers');
const chatService = await import('../src/lib/chat-service.ts');

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `chat-svc-test-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
      name: 'chat-service test',
    },
  });
  const other = await prisma.user.create({
    data: {
      email: `chat-svc-other-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
    },
  });
  userId = user.id;
  otherUserId = other.id;
});

afterAll(async () => {
  // 级联清理：删 user 即删 conversations/runs/events/messages。
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

function fakeFactory(script: readonly string[], perTokenDelayMs = 0) {
  return () => new FakeProvider(script, { perTokenDelayMs });
}

describe('sendChat', () => {
  it('runs the full flow: run.started → provider.delta* → run.succeeded and persists assistant message', async () => {
    chatService.setChatProviderFactory(fakeFactory(['hello streaming world']));

    const res = await chatService.sendChat({
      userId,
      content: 'hi there',
      modelKey: 'fake-model',
      idempotencyKey: `itest-full-${Date.now()}`,
    });

    expect(res.conversationId).toBeTruthy();
    expect(res.messageId).toBeTruthy();
    expect(res.runId).toBeTruthy();

    const events = await prisma.runEvent.findMany({
      where: { runId: res.runId },
      orderBy: { seq: 'asc' },
    });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.succeeded');
    const deltaCount = types.filter((t) => t === 'provider.delta').length;
    expect(deltaCount).toBeGreaterThan(0);
    // seq 严格递增
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const run = await prisma.orchestrationRun.findUnique({ where: { id: res.runId } });
    expect(run?.status).toBe('SUCCEEDED');
    expect((run?.configSnapshot as { modelKey: string }).modelKey).toBe('fake-model');
    expect((run?.configSnapshot as { contentLength: number }).contentLength).toBe('hi there'.length);

    const messages = await prisma.message.findMany({
      where: { conversationId: res.conversationId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('hi there');
    expect(messages[1]?.content).toBe('hello streaming world');
    expect(messages[1]?.status).toBe('COMPLETE');

    const deltas = events
      .filter((e) => e.type === 'provider.delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('');
    expect(deltas).toBe('hello streaming world');
  });

  it('is idempotent: same idempotencyKey returns the same run', async () => {
    chatService.setChatProviderFactory(fakeFactory(['same response']));
    const key = `itest-idem-${Date.now()}`;

    const first = await chatService.sendChat({
      userId,
      content: 'once',
      modelKey: 'fake-model',
      idempotencyKey: key,
    });
    const second = await chatService.sendChat({
      userId,
      content: 'once',
      modelKey: 'fake-model',
      idempotencyKey: key,
    });

    expect(second.runId).toBe(first.runId);
    expect(second.conversationId).toBe(first.conversationId);
    // 不应产生第二个 run / 第二份事件
    const runs = await prisma.orchestrationRun.findMany({
      where: { ownerId: userId, idempotencyKey: key },
    });
    expect(runs).toHaveLength(1);
  });

  it('stop aborts an in-flight run to CANCELLED', async () => {
    // 每 token 延迟，保证 stop 有窗口打到进行中的流。
    chatService.setChatProviderFactory(
      fakeFactory(['a b c d e f g h i j k l m n o p'], 60),
    );

    const sendPromise = chatService.sendChat({
      userId,
      content: 'cancel me',
      modelKey: 'fake-model',
      idempotencyKey: `itest-stop-${Date.now()}`,
    });

    // 等 run 注册（run.started 事件出现即说明控制器已挂上）。
    let runId = '';
    for (let i = 0; i < 100; i++) {
      const runs = await prisma.orchestrationRun.findMany({
        where: { ownerId: userId, idempotencyKey: { startsWith: 'itest-stop-' } },
        orderBy: { createdAt: 'desc' },
      });
      const running = runs.find((r) => r.status === 'RUNNING');
      if (running) {
        runId = running.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runId).not.toBe('');

    const stopRes = await chatService.stopChat({ userId, runId });
    expect(stopRes).toEqual({ ok: true });
    // 幂等：再次 stop 仍 ok。
    await expect(chatService.stopChat({ userId, runId })).resolves.toEqual({ ok: true });

    const res = await sendPromise;
    expect(res.runId).toBe(runId);

    const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('CANCELLED');
    const events = await prisma.runEvent.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
    });
    expect(events.at(-1)?.type).toBe('run.cancelled');
  });

  it('returns 404-shaped error when another user owns the conversation', async () => {
    chatService.setChatProviderFactory(fakeFactory(['should not run']));
    const conv = await prisma.conversation.create({
      data: { ownerId: otherUserId, title: 'not yours', type: 'SINGLE' },
    });
    await expect(
      chatService.sendChat({
        userId,
        conversationId: conv.id,
        content: 'intrude',
        modelKey: 'fake-model',
        idempotencyKey: `itest-404-${Date.now()}`,
      }),
    ).rejects.toBeInstanceOf(chatService.ChatNotFoundError);

    await expect(
      chatService.stopChat({ userId, runId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(chatService.ChatNotFoundError);
  });
});
