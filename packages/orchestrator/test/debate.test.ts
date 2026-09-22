import { describe, expect, it } from 'vitest';
import { createEngine, debateStrategy } from '../src';
import type { CallModel, ChatMessage, EngineEvent, Phase, SeatConfig, StrategyContextInput } from '../src';

function seat(seatId: string, role: string): SeatConfig {
  return { seatId, modelKey: `model-${seatId}`, role, systemPrompt: `prompt for ${seatId}` };
}

function harness(seats: SeatConfig[], callModel: CallModel, userContent = 'question') {
  const events: EngineEvent[] = [];
  const phases: Phase[] = [];
  const engine = createEngine({
    emit: (e) => events.push(e),
    updatePhase: (p) => phases.push(p),
    callModel,
  });
  const ctx: StrategyContextInput = { runId: 'run-1', seats, userContent };
  return { engine, ctx, events, phases };
}

function recorder(replies: Map<string, string | Error>): {
  calls: Array<{ seatId: string; messages: ChatMessage[] }>;
  callModel: CallModel;
} {
  const calls: Array<{ seatId: string; messages: ChatMessage[] }> = [];
  const callModel: CallModel = async (s, messages) => {
    calls.push({ seatId: s.seatId, messages });
    const reply = replies.get(s.seatId);
    if (reply instanceof Error) throw reply;
    return reply ?? `reply-from-${s.seatId}`;
  };
  return { calls, callModel };
}

const seats4 = () => [seat('p1', 'pro'), seat('p2', 'pro'), seat('c1', 'con'), seat('j', 'judge')];

describe('debateStrategy', () => {
  it('2pro+1con+1judge, two rounds: full event sequence and speaking order', async () => {
    const { calls, callModel } = recorder(new Map([['j', 'verdict']]));
    const { engine, ctx, events, phases } = harness(seats4(), callModel);

    const result = await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 2 });

    expect(result.assistantMessageContent).toBe('verdict');
    expect(result.degraded).toBeUndefined();

    // round 1: p1, p2, c1; round 2: p1, p2, c1; then judge
    expect(calls.map((c) => c.seatId)).toEqual(['p1', 'p2', 'c1', 'p1', 'p2', 'c1', 'j']);
    // round-1 con sees this round's pro utterances
    expect(calls[2]!.messages).toEqual([
      { role: 'system', content: 'prompt for c1' },
      { role: 'assistant', content: '[正方] reply-from-p1' },
      { role: 'assistant', content: '[正方] reply-from-p2' },
      { role: 'user', content: 'question' },
    ]);
    // round-2 pro sees round-1 con
    expect(calls[3]!.messages).toEqual([
      { role: 'system', content: 'prompt for p1' },
      { role: 'assistant', content: '[正方] reply-from-p1' },
      { role: 'assistant', content: '[正方] reply-from-p2' },
      { role: 'assistant', content: '[反方] reply-from-c1' },
      { role: 'user', content: 'question' },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'run.planning',
      'provider.call.completed',
      'provider.call.completed',
      'provider.call.completed',
      'run.round.completed',
      'provider.call.completed',
      'provider.call.completed',
      'provider.call.completed',
      'run.round.completed',
      'provider.call.completed',
      'judge.result',
      'run.succeeded',
    ]);
    expect(events.filter((e) => e.type === 'run.round.completed').map((e) => e.payload)).toEqual([
      { round: 1, seatsDone: 3 },
      { round: 2, seatsDone: 3 },
    ]);
    // debate seats' call events carry round + stance
    expect(events[1]!.payload).toMatchObject({ seatId: 'p1', round: 1, stance: 'pro' });
    expect(events[3]!.payload).toMatchObject({ seatId: 'c1', round: 1, stance: 'con' });
    expect(events.at(-1)!.payload).toMatchObject({ degraded: false });
    expect(phases).toEqual(['PLANNING', 'ROUND', 'JUDGING']);

    const judgeResult = events.find((e) => e.type === 'judge.result')!;
    expect(judgeResult.payload).toEqual({ rounds: 2, judgeModelKey: 'model-j' });
  });

  it('judge input is anonymized: no modelKey/seatId, stance labels present', async () => {
    const { calls, callModel } = recorder(new Map([['j', 'verdict']]));
    const { engine, ctx } = harness(seats4(), callModel);
    await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 1 });

    const judgeMessages = calls.at(-1)!.messages;
    const flattened = JSON.stringify(judgeMessages);
    expect(flattened).not.toContain('model-p1');
    expect(flattened).not.toContain('model-c1');
    expect(flattened).not.toContain('model-qwen');
    // seatId 断言限定在结构标注（“seatId”字段），发言内容自身不含身份前缀即可
    expect(flattened).not.toContain('seatId');
    expect(flattened).toContain('[正方]');
    expect(flattened).toContain('[反方]');
    expect(judgeMessages[0]).toEqual({
      role: 'system',
      content: 'prompt for j\n禁止偏向任何一方，基于论证质量评判。',
    });
  });

  it('judge failure fails the whole run', async () => {
    const { callModel } = recorder(new Map([['j', new Error('judge boom')]]));
    const { engine, ctx, events } = harness(seats4(), callModel);

    await expect(engine.runStrategy(debateStrategy, ctx)).rejects.toThrow('judge seat j failed');
    expect(events.at(-1)!.type).toBe('run.failed');
    expect(events.filter((e) => e.type === 'judge.result')).toHaveLength(0);
  });

  it('pro seat failure degrades but the run succeeds', async () => {
    const { calls, callModel } = recorder(
      new Map<string, string | Error>([
        ['p1', new Error('provider boom')],
        ['j', 'verdict'],
      ]),
    );
    const { engine, ctx, events } = harness(seats4(), callModel);

    const result = await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 1 });

    expect(result.assistantMessageContent).toBe('verdict');
    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([expect.stringContaining('seat p1 failed in round 1')]);
    expect(calls.map((c) => c.seatId)).toEqual(['p1', 'p2', 'c1', 'j']);
    expect(events.at(-1)!.type).toBe('run.succeeded');
  });

  it('maxRounds=1 runs a single round', async () => {
    const { calls, callModel } = recorder(new Map([['j', 'verdict']]));
    const { engine, ctx, events } = harness(seats4(), callModel);

    const result = await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 1 });

    expect(result.assistantMessageContent).toBe('verdict');
    expect(events.filter((e) => e.type === 'run.round.completed')).toHaveLength(1);
    expect(calls.filter((c) => c.seatId !== 'j')).toHaveLength(3);
  });

  it('judge-same-model is recorded in reasons for the M4 ablation', async () => {
    const seats = seats4().map((s) => (s.role === 'pro' ? { ...s, modelKey: 'model-j' } : s));
    const { callModel } = recorder(new Map([['j', 'verdict']]));
    const { engine, ctx } = harness(seats, callModel);

    const result = await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 1 });
    expect(result.reasons).toContain('judge-same-model');
    expect(result.degraded).toBe(true);
  });
});

it('M4 集成验证: maxRounds=2 时席位调用总数 = pro*2 + con*2 + judge', async () => {
  const calls: string[] = [];
  const callModel = async (s: { seatId: string }) => {
    calls.push(s.seatId);
    return `r-${s.seatId}`;
  };
  const { engine, ctx } = harness(
    [
      { seatId: 'p', modelKey: 'm1', role: 'pro', systemPrompt: 's' },
      { seatId: 'c', modelKey: 'm2', role: 'con', systemPrompt: 's' },
      { seatId: 'j', modelKey: 'm1', role: 'judge', systemPrompt: 's' },
    ] as never,
    callModel as never,
  );
  await engine.runStrategy(debateStrategy, { ...ctx, maxRounds: 2 });
  // 2 轮 × (1 pro + 1 con) + 1 裁判 = 5 次调用
  if (calls.length !== 5) throw new Error(`expected 5 calls got ${calls.length}: ${calls.join(',')}`);
});
