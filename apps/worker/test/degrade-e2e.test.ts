/** M4 degraded + backup-seat substitution e2e：fake 注入故障席位，验证降级标志与备席接管（vitest + 测试库）。 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

config();

const { prisma } = await import('@aichat/db');
const { processCollabRun } = await import('../src/collab-runner');
const { FakeProvider } = await import('@aichat/providers');

let userId = '';
let convId = '';
const runs: string[] = [];

beforeAll(async () => {
  const u = await prisma.user.create({
    data: { email: `m4-degrade-${Date.now()}@local`, passwordHash: 'x' },
  });
  userId = u.id;
  convId = (await prisma.conversation.create({
    data: { ownerId: userId, title: 'degrade', type: 'GROUP' },
  })).id;
});

afterAll(async () => {
  await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
  await prisma.conversation.deleteMany({ where: { id: convId } });
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

async function makeRun(seats: Array<{ seatId: string; role: string; prompt?: string }>): Promise<string> {
  const m = await prisma.message.create({
    data: { conversationId: convId, content: '任务', status: 'PENDING' },
  });
  const r = await prisma.orchestrationRun.create({
    data: {
      conversationId: convId, ownerId: userId, status: 'RUNNING',
      leaseOwner: 'degrade-w', leaseExpiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: `m4-degrade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      configSnapshot: {
        mode: 'GROUP', content: '任务', userMessageId: m.id,
        seats: seats.map((s) => ({
          seatId: s.seatId, modelKey: 'fake-d', role: s.role,
          // systemPrompt 埋 seatId：ThrowingProviderForSeat 靠它识别故障席
          systemPrompt: s.prompt ?? `seatmark:${s.seatId}`,
        })),
      },
    },
  });
  for (const s of seats) {
    await prisma.runParticipantSnapshot.create({
      data: {
        runId: r.id, seatId: s.seatId, providerKey: 'ollama',
        modelKey: 'fake-d', systemPrompt: s.prompt ?? `seatmark:${s.seatId}`,
        params: { role: s.role }, pricingVersion: 'local-0',
      },
    });
  }
  runs.push(r.id);
  return r.id;
}

describe('M4 degraded + backup substitution', () => {
  it('seat failure without backup → degraded=true persisted, run still SUCCEEDED', async () => {
    const runId = await makeRun([
      { seatId: 's1', role: 'member' },
      { seatId: 's2-bad', role: 'member' }, // 该席位 provider 将抛错
      { seatId: 's3', role: 'summarizer' },
    ]);
    await processCollabRun(runId, 'degrade-w', {
      providerFactory: (modelKey) =>
        modelKey === 'fake-d'
          ? new ThrowingProviderForSeat('s2-bad')
          : new FakeProvider(['ok-reply']),
    } as never);

    const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('SUCCEEDED');
    expect(run?.degraded).toBe(true);
    expect(Array.isArray(run?.degradationReasons)).toBe(true);
    const reasons = JSON.stringify(run?.degradationReasons);
    expect(reasons).toContain('s2-bad');
  });

  it('seat failure WITH backup seat → substitution event, no degraded flag', async () => {
    const runId = await makeRun([
      { seatId: 's1', role: 'member' },
      { seatId: 's2-bad', role: 'member' },
      { seatId: 's2-backup', role: 'member' }, // 备席约定：-backup 后缀
      { seatId: 's3', role: 'summarizer' },
    ]);
    await processCollabRun(runId, 'degrade-w', {
      providerFactory: () => new ThrowingProviderForSeat('s2-bad'),
    } as never);

    const run = await prisma.orchestrationRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('SUCCEEDED');
    const events = await prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: 'asc' } });
    const types = events.map((e) => e.type);
    expect(types).toContain('collab.seat.substituted');
    const sub = events.find((e) => e.type === 'collab.seat.substituted');
    expect(sub?.payload).toMatchObject({ from: 's2-bad', to: 's2-backup' });
    // 备席成功接管 → 无 degraded
    expect(run?.degraded).toBe(false);
  });
});

/** 按 seatId 选择性抛错的 provider 包装（M4 故障注入）。 */
class ThrowingProviderForSeat {
  constructor(private readonly badSeat: string) {}
  capabilities() {
    return new FakeProvider(['x']).capabilities();
  }
  async *streamChat(messages: Array<{ role: string; content: string }>) {
    // system prompt 里带了席位标识（测试造数时 systemPrompt 含 seatId）
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes(this.badSeat)) {
      yield { type: 'error' as const, error: `injected failure for ${this.badSeat}` };
      return;
    }
    yield { type: 'text-delta' as const, delta: `ok-${sys.slice(0, 10)}` };
    yield { type: 'done' as const, finishReason: 'stop' as const };
  }
}
