import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 直连 DB 的路由单测：mock better-auth 会话，userId 用例内注入。
const sessionState: { userId: string | null } = { userId: null };

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: async (_args: { headers: Headers }) =>
        sessionState.userId ? { user: { id: sessionState.userId } } : null,
    },
  },
}));

// eslint-disable-next-line import/first
import { prisma } from '@aichat/db';
// eslint-disable-next-line import/first
import { POST } from '../src/app/api/collab/run/route';

const ids: { userId?: string; otherUserId?: string; conversationId?: string; runId?: string } = {};

async function cleanup(): Promise<void> {
  if (ids.runId) await prisma.orchestrationRun.deleteMany({ where: { id: ids.runId } });
  if (ids.conversationId) await prisma.conversation.deleteMany({ where: { id: ids.conversationId } });
  if (ids.otherUserId) await prisma.user.deleteMany({ where: { id: ids.otherUserId } });
  if (ids.userId) await prisma.user.deleteMany({ where: { id: ids.userId } });
}

function makeBody(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/collab/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: ids.conversationId,
      mode: 'GROUP',
      seats: [
        { seatId: 's1', modelId: 'qwen3:0.6b', role: 'analyst', systemPrompt: '你是分析师' },
        { seatId: 's2', modelId: 'qwen3:0.6b', role: 'critic', systemPrompt: '你是评审' },
      ],
      tokenBudget: 1000,
      idempotencyKey: `itest-${Date.now()}`,
      content: 'hello collab',
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.userId = (await prisma.user.create({
    data: {
      email: `collab-api-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
      name: 'collab-api-owner',
    },
  })).id;
  ids.otherUserId = (await prisma.user.create({
    data: {
      email: `collab-api-other-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
    },
  })).id;
  ids.conversationId = (
    await prisma.conversation.create({
      data: { title: 'collab-api-test', type: 'GROUP', ownerId: ids.userId! },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('POST /api/collab/run', () => {
  it('creates a 2-seat GROUP run and persists two participant snapshots', async () => {
    sessionState.userId = ids.userId!;
    const res = await POST(makeBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();
    ids.runId = body.runId;

    const run = await prisma.orchestrationRun.findUnique({
      where: { id: body.runId },
      include: { participantSnapshots: true },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('PENDING');
    expect(run!.participantSnapshots).toHaveLength(2);
    expect(run!.participantSnapshots.map((s) => s.seatId).sort()).toEqual(['s1', 's2']);
    for (const seat of run!.participantSnapshots) {
      expect(seat.providerKey).toBe('ollama');
      expect(seat.pricingVersion).toBe('local-0');
      expect((seat.params as { role?: string }).role).toBeTruthy();
    }
    const snapshot = run!.configSnapshot as { mode?: string; content?: string; userMessageId?: string };
    expect(snapshot.mode).toBe('GROUP');
    expect(snapshot.content).toBe('hello collab');
    expect(snapshot.userMessageId).toBeTruthy();
  });

  it('replays idempotently: same idempotencyKey returns the same runId', async () => {
    sessionState.userId = ids.userId!;
    const first = await POST(makeBody({ idempotencyKey: 'idem-replay-key' }));
    const second = await POST(makeBody({ idempotencyKey: 'idem-replay-key' }));
    const a = (await first.json()) as { runId: string };
    const b = (await second.json()) as { runId: string };
    expect(b.runId).toBe(a.runId);
    // 幂等重放不产生重复 run。
    const count = await prisma.orchestrationRun.count({
      where: { ownerId: ids.userId, idempotencyKey: 'idem-replay-key' },
    });
    expect(count).toBe(1);
    // 清理本轮创建的 run（幂等键不同）。
    await prisma.orchestrationRun.deleteMany({ where: { id: a.runId } });
  });

  it('creates a 4-seat DEBATE run (2 pro / 1 con / 1 judge) with four participant snapshots', async () => {
    sessionState.userId = ids.userId!;
    const res = await POST(makeBody({
      mode: 'DEBATE',
      seats: [
        { seatId: 'pro-1', modelId: 'qwen3:0.6b', role: 'pro', systemPrompt: '你是正方一辩' },
        { seatId: 'pro-2', modelId: 'qwen3:0.6b', role: 'pro', systemPrompt: '你是正方二辩' },
        { seatId: 'con-1', modelId: 'qwen3:0.6b', role: 'con', systemPrompt: '你是反方' },
        { seatId: 'judge-1', modelId: 'qwen3:0.6b', role: 'judge', systemPrompt: '你是裁判' },
      ],
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();

    const run = await prisma.orchestrationRun.findUnique({
      where: { id: body.runId },
      include: { participantSnapshots: true },
    });
    expect(run).not.toBeNull();
    expect(run!.participantSnapshots).toHaveLength(4);
    const snapshot = run!.configSnapshot as { mode?: string };
    expect(snapshot.mode).toBe('DEBATE');
    // 清理（idempotencyKey 与主用例不同）。
    await prisma.orchestrationRun.deleteMany({ where: { id: body.runId } });
  });

  it('returns 404 when the conversation belongs to someone else', async () => {
    sessionState.userId = ids.otherUserId!;
    const res = await POST(makeBody());
    expect(res.status).toBe(404);
  });
});
