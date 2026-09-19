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
import { GET as getEvents } from '../src/app/api/runs/[runId]/events/route';
// eslint-disable-next-line import/first
import { GET as getUsage } from '../src/app/api/runs/[runId]/usage/route';

const ids: { userId?: string; otherUserId?: string; conversationId?: string; runId?: string } = {};

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
      email: `run-timeline-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
      name: 'run-timeline-owner',
    },
  })).id;
  ids.otherUserId = (await prisma.user.create({
    data: {
      email: `run-timeline-other-${suffix}@example.com`,
      passwordHash: 'not-a-real-hash',
    },
  })).id;
  ids.conversationId = (
    await prisma.conversation.create({
      data: { title: 'run-timeline-test', type: 'GROUP', ownerId: ids.userId! },
    })
  ).id;

  const run = await prisma.orchestrationRun.create({
    data: {
      conversationId: ids.conversationId!,
      ownerId: ids.userId!,
      status: 'SUCCEEDED',
      idempotencyKey: `timeline-test-${suffix}`,
      configSnapshot: { mode: 'GROUP' },
    },
  });
  ids.runId = run.id;

  // 两个席位快照 + 各自的 provider call 与 usage log（s2 无关联快照 → unassigned）
  for (const seat of ['s1', 's2']) {
    const snapshot = await prisma.runParticipantSnapshot.create({
      data: {
        runId: run.id,
        seatId: seat,
        providerKey: 'ollama',
        modelKey: 'qwen3:0.6b',
        systemPrompt: `你是 ${seat}`,
        params: { role: 'analyst' },
        pricingVersion: 'local-0',
      },
    });
    const call = await prisma.providerCall.create({
      data: {
        runId: run.id,
        participantSnapshotId: snapshot.id,
        attempt: 1,
        requestHash: `timeline-call-${seat}-${suffix}`,
        endedAt: new Date(),
      },
    });
    await prisma.usageLog.create({
      data: {
        userId: ids.userId!,
        runId: run.id,
        callId: call.id,
        tokens: seat === 's1' ? 100 : 50,
        costMicros: seat === 's1' ? 200n : 80n,
      },
    });
  }

  await prisma.runEvent.createMany({
    data: [
      { runId: run.id, seq: 1, type: 'run.started', payload: {} },
      { runId: run.id, seq: 2, type: 'collab.seat.started', payload: { seatId: 's1', round: 1 } },
      { runId: run.id, seq: 3, type: 'collab.seat.completed', payload: { seatId: 's1', round: 1, durationMs: 90 } },
      { runId: run.id, seq: 4, type: 'collab.seat.substituted', payload: { fromSeatId: 's2', toSeatId: 's2-backup' } },
      { runId: run.id, seq: 5, type: 'run.succeeded', payload: {} },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('GET /api/runs/[runId]/events?format=json', () => {
  it('returns 404 when not authenticated', async () => {
    sessionState.userId = null;
    const res = await getEvents(
      new Request(`http://localhost/api/runs/${ids.runId}/events?after=0&format=json`),
      ctx(ids.runId!),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for another user\'s run', async () => {
    sessionState.userId = ids.otherUserId!;
    const res = await getEvents(
      new Request(`http://localhost/api/runs/${ids.runId}/events?after=0&format=json`),
      ctx(ids.runId!),
    );
    expect(res.status).toBe(404);
  });

  it('returns the full event list ordered by seq', async () => {
    sessionState.userId = ids.userId!;
    const res = await getEvents(
      new Request(`http://localhost/api/runs/${ids.runId}/events?after=0&format=json`),
      ctx(ids.runId!),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { runId: string; seq: number; type: string; time: string; payload: Record<string, unknown> }[];
    };
    expect(body.events).toHaveLength(5);
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(body.events[1]!.type).toBe('collab.seat.started');
    expect(body.events[1]!.payload.seatId).toBe('s1');
    expect(body.events.every((e: { runId: string }) => e.runId === ids.runId)).toBe(true);
  });

  it('honors the after cursor', async () => {
    sessionState.userId = ids.userId!;
    const res = await getEvents(
      new Request(`http://localhost/api/runs/${ids.runId}/events?after=3&format=json`),
      ctx(ids.runId!),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([4, 5]);
  });
});

describe('GET /api/runs/[runId]/usage', () => {
  it('returns 404 when not authenticated', async () => {
    sessionState.userId = null;
    const res = await getUsage(new Request(`http://localhost/api/runs/${ids.runId}/usage`), ctx(ids.runId!));
    expect(res.status).toBe(404);
  });

  it('returns 404 for another user\'s run', async () => {
    sessionState.userId = ids.otherUserId!;
    const res = await getUsage(new Request(`http://localhost/api/runs/${ids.runId}/usage`), ctx(ids.runId!));
    expect(res.status).toBe(404);
  });

  it('summarizes usage by seatId with totals', async () => {
    sessionState.userId = ids.userId!;
    const res = await getUsage(new Request(`http://localhost/api/runs/${ids.runId}/usage`), ctx(ids.runId!));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string;
      seats: { seatId: string; calls: number; tokens: number; costMicros: number }[];
      totals: { calls: number; tokens: number; costMicros: number };
    };
    expect(body.runId).toBe(ids.runId);
    expect(body.seats).toHaveLength(2);
    const s1 = body.seats.find((s) => s.seatId === 's1');
    const s2 = body.seats.find((s) => s.seatId === 's2');
    expect(s1).toMatchObject({ calls: 1, tokens: 100, costMicros: 200 });
    expect(s2).toMatchObject({ calls: 1, tokens: 50, costMicros: 80 });
    expect(body.totals).toEqual({ calls: 2, tokens: 150, costMicros: 280 });
  });
});
