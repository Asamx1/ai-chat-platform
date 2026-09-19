import { describe, expect, it } from 'vitest';
import { createEngine, consensusStrategy, groupStrategy } from '../src';
import type { CallModel, ChatMessage, EngineEvent, Phase, SeatConfig, StrategyContextInput } from '../src';

function seat(seatId: string, role = 'member'): SeatConfig {
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

/** Fake callModel that records the messages it receives and returns a canned reply. */
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

describe('groupStrategy', () => {
  it('3 seats speak in order with full event sequence; content contains each output', async () => {
    const seats = [seat('a'), seat('b'), seat('c')];
    const { calls, callModel } = recorder(
      new Map([
        ['a', 'alpha'],
        ['b', 'beta'],
        ['c', 'gamma'],
      ]),
    );
    const { engine, ctx, events, phases } = harness(seats, callModel);

    const result = await engine.runStrategy(groupStrategy, ctx);

    expect(result.assistantMessageContent).toBe('gamma'); // last seat is final
    expect(result.degraded).toBeUndefined();

    expect(calls.map((c) => c.seatId)).toEqual(['a', 'b', 'c']);
    // seat b sees a's utterance labelled with seatId, seat c sees both
    expect(calls[1]!.messages).toEqual([
      { role: 'system', content: 'prompt for b' },
      { role: 'assistant', content: '[a] alpha' },
      { role: 'user', content: 'question' },
    ]);
    expect(calls[2]!.messages[1]).toEqual({ role: 'assistant', content: '[a] alpha' });
    expect(calls[2]!.messages[2]).toEqual({ role: 'assistant', content: '[b] beta' });

    expect(events.map((e) => e.type)).toEqual([
      'run.planning',
      'provider.call.completed',
      'provider.call.completed',
      'provider.call.completed',
      'run.round.completed',
      'run.succeeded',
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(phases).toEqual(['PLANNING', 'ROUND']);
    expect(events[5]!.payload).toMatchObject({ degraded: false });
  });

  it('maxRounds=2 runs two full rounds', async () => {
    const seats = [seat('a'), seat('b')];
    const { callModel } = recorder(new Map());
    const { engine, ctx, events } = harness(seats, callModel);
    const result = await engine.runStrategy(groupStrategy, { ...ctx, maxRounds: 2 });

    expect(events.filter((e) => e.type === 'provider.call.completed' && !e.payload.failed).length).toBe(4);
    expect(events.filter((e) => e.type === 'run.round.completed').length).toBe(2);
    expect(result.assistantMessageContent).toBe('reply-from-b');
  });

  it('seat failure degrades but succeeds', async () => {
    const seats = [seat('a'), seat('b')];
    const { callModel } = recorder(new Map([['a', new Error('provider boom')]]));
    const { engine, ctx, events } = harness(seats, callModel);

    const result = await engine.runStrategy(groupStrategy, ctx);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([expect.stringContaining('seat a failed')]);
    expect(result.assistantMessageContent).toBe('reply-from-b');
    expect(events.at(-1)!.type).toBe('run.succeeded');
  });
});

describe('consensusStrategy', () => {
  it('3+1 seats: candidates parallel, synthesizer input has no model/seat identity', async () => {
    const seats = [seat('a'), seat('b'), seat('c'), seat('synth', 'synthesizer')];
    const { calls, callModel } = recorder(new Map([['synth', 'final answer']]));
    const { engine, ctx, events, phases } = harness(seats, callModel);

    const result = await engine.runStrategy(consensusStrategy, ctx);

    expect(result.assistantMessageContent).toBe('final answer');
    expect(calls.map((c) => c.seatId)).toEqual(['a', 'b', 'c', 'synth']);
    // candidates get only system+user
    for (const c of calls.slice(0, 3)) {
      expect(c.messages).toEqual([
        { role: 'system', content: `prompt for ${c.seatId}` },
        { role: 'user', content: 'question' },
      ]);
    }
    const synthMessages = calls[3]!.messages;
    const flattened = JSON.stringify(synthMessages);
    expect(flattened).not.toContain('model-a');
    expect(flattened).not.toContain('seatId');
    expect(flattened).toContain('候选 1');
    expect(flattened).toContain('reply-from-c');

    expect(events.map((e) => e.type)).toEqual([
      'run.planning',
      'provider.call.completed',
      'provider.call.completed',
      'provider.call.completed',
      'provider.call.completed',
      'run.succeeded',
    ]);
    expect(phases).toEqual(['PLANNING', 'ROUND', 'SYNTHESIZING']);
  });

  it('parallelism: candidate calls overlap in time', async () => {
    const seats = [seat('a'), seat('b'), seat('synth', 'synthesizer')];
    let active = 0;
    let maxActive = 0;
    const callModel: CallModel = async (s) => {
      if (s.role === 'synthesizer') return 'final';
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return `reply-from-${s.seatId}`;
    };
    const { engine, ctx } = harness(seats, callModel);
    await engine.runStrategy(consensusStrategy, ctx);
    expect(maxActive).toBe(2);
  });

  it('candidate failure degrades but run succeeds', async () => {
    const seats = [seat('a'), seat('b'), seat('synth', 'synthesizer')];
    const { callModel } = recorder(
      new Map([
        ['a', new Error('timeout')],
        ['synth', 'merged'],
      ]),
    );
    const { engine, ctx, events } = harness(seats, callModel);

    const result = await engine.runStrategy(consensusStrategy, ctx);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual([expect.stringContaining('seat a failed')]);
    expect(result.assistantMessageContent).toBe('merged');
    expect(events.at(-1)!.type).toBe('run.succeeded');
  });
});
