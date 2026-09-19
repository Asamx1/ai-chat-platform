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
import { createHash } from 'node:crypto';
// eslint-disable-next-line import/first
import { prisma } from '@aichat/db';
// eslint-disable-next-line import/first
import { GET } from '../src/app/api/runs/[runId]/export/route';

const ids: { userId?: string; otherUserId?: string; conversationId?: string; runId?: string } = {};

function makeRequest(runId: string): Request {
  return new Request(`http://localhost/api/runs/${runId}/export`);
}

function ctx(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

async function cleanup(): Promise<void> {
  if (ids.runId) await prisma.orchestrationRun.deleteMany({ where: { id: ids.runId } });
  if (ids.conversationId) await prisma.conversation.deleteMany({ where: { id: ids.conversationId } });
  if (ids.otherUserId) await prisma.user.deleteMany({ where: { id: ids.otherUserId } });
  if (ids.userId) await prisma.user.deleteMany({ where: { id: ids.userId } });
}

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.userId = (await prisma.user.create({
    data: {
      email: `run-export-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
      name: 'run-export-owner',
    },
  })).id;
  ids.otherUserId = (await prisma.user.create({
    data: {
      email: `run-export-other-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
    },
  })).id;
  ids.conversationId = (
    await prisma.conversation.create({
      data: { title: 'run-export-test', type: 'GROUP', ownerId: ids.userId! },
    })
  ).id;

  const configSnapshot = { mode: 'GROUP', content: 'export me', tokenBudget: 1000 };
  const run = await prisma.orchestrationRun.create({
    data: {
      conversationId: ids.conversationId!,
      ownerId: ids.userId!,
      status: 'SUCCEEDED',
      attempt: 1,
      idempotencyKey: `export-test-${suffix}`,
      degraded: true,
      degradationReasons: ['s2 fallback'],
      configSnapshot,
    },
  });
  ids.runId = run.id;

  const snapshot = await prisma.runParticipantSnapshot.create({
    data: {
      runId: run.id,
      seatId: 's1',
      providerKey: 'ollama',
      modelKey: 'qwen3:0.6b',
      systemPrompt: '你是分析师',
      params: { role: 'analyst' },
      pricingVersion: 'local-0',
    },
  });

  await prisma.runEvent.createMany({
    data: [
      { runId: run.id, seq: 1, type: 'run.started', payload: {} },
      { runId: run.id, seq: 2, type: 'collab.seat.started', payload: { seatId: 's1', round: 1 } },
      { runId: run.id, seq: 3, type: 'collab.seat.completed', payload: { seatId: 's1', round: 1, durationMs: 120 } },
      { runId: run.id, seq: 4, type: 'run.succeeded', payload: {} },
    ],
  });

  const call = await prisma.providerCall.create({
    data: {
      runId: run.id,
      participantSnapshotId: snapshot.id,
      attempt: 1,
      requestHash: `export-test-call-${suffix}`,
      usage: { promptTokens: 10, completionTokens: 5 },
      endedAt: new Date(),
    },
  });
  await prisma.usageLog.create({
    data: {
      userId: ids.userId!,
      runId: run.id,
      callId: call.id,
      tokens: 15,
      costMicros: 30n,
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('GET /api/runs/[runId]/export', () => {
  it('returns 404 when not authenticated', async () => {
    sessionState.userId = null;
    const res = await GET(makeRequest(ids.runId!), ctx(ids.runId!));
    expect(res.status).toBe(404);
  });

  it('returns 404 for another user\'s run', async () => {
    sessionState.userId = ids.otherUserId!;
    const res = await GET(makeRequest(ids.runId!), ctx(ids.runId!));
    expect(res.status).toBe(404);
  });

  it('exports the full run with configHash, events and usage totals', async () => {
    sessionState.userId = ids.userId!;
    const res = await GET(makeRequest(ids.runId!), ctx(ids.runId!));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="run-${ids.runId}.json"`,
    );

    const body = (await res.json()) as {
      version: number;
      exportedAt: string;
      run: {
        configHash: string;
        configSnapshot: unknown;
        degraded: boolean;
        degradationReasons: string[];
        attempt: number;
      };
      seats: { seatId: string }[];
      events: { seq: number; type: string }[];
      usage: { tokens: number; costMicros: number }[];
      calls: { id: string; attempt: number }[];
    };

    expect(body.version).toBe(1);
    expect(body.exportedAt).toBeTruthy();

    // configHash = sha256(JSON.stringify(configSnapshot)) 截 16 hex
    const expected = createHash('sha256')
      .update(JSON.stringify(body.run.configSnapshot))
      .digest('hex')
      .slice(0, 16);
    expect(body.run.configHash).toBe(expected);
    expect(body.run.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.run.degraded).toBe(true);
    expect(body.run.degradationReasons).toEqual(['s2 fallback']);
    expect(body.run.attempt).toBe(1);

    expect(body.seats.map((s) => s.seatId)).toEqual(['s1']);
    expect(body.events).toHaveLength(4);
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    // UsageLog 汇总 tokens
    expect(body.usage).toHaveLength(1);
    expect(body.usage.reduce((s, u) => s + u.tokens, 0)).toBe(15);
    expect(body.usage[0]!.costMicros).toBe(30);

    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]!.attempt).toBe(1);
  });

  it('returns 404 for a nonexistent run', async () => {
    sessionState.userId = ids.userId!;
    const res = await GET(makeRequest('no-such-run'), ctx('no-such-run'));
    expect(res.status).toBe(404);
  });
});
