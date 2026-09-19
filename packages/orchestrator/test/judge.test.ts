import { describe, expect, it } from 'vitest';
import { anonymize, fisherYatesShuffle, judgePair, type JudgeCandidate } from '../src/judge';
import { VerdictSchema, buildJudgePrompt } from '../src/judge-schema';
import type { CallModel, SeatConfig } from '../src';

/** Deterministic rng from a seed (mulberry32). */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function judgeSeat(modelKey = 'judge-m'): SeatConfig {
  return { seatId: 'judge', modelKey, role: 'judge', systemPrompt: 'sys' };
}

function cand(seatId: string, modelKey: string, content: string): JudgeCandidate {
  return { seatId, modelKey, content };
}

/** callModel stub returning queued replies; records each call's messages. */
function judgeModel(replies: string[]) {
  const calls: Array<{ messages: ReturnType<typeof buildJudgePrompt> }> = [];
  let i = 0;
  const callModel: CallModel = async (_seat, messages) => {
    calls.push({ messages });
    const reply = replies[i++];
    if (reply === undefined) throw new Error('no more canned replies');
    return reply;
  };
  return { callModel, calls };
}

const TASK = '写一首俳句';
const CANDIDATES = [
  cand('s1', 'model-x', '古池や\n蛙飛び込む\n水の音'),
  cand('s2', 'model-y', '静けさや\n岩にしみ入る\n蝉の声'),
];

const VALID_VERDICT = JSON.stringify({
  winner: 'A',
  confidence: 0.8,
  rationale: 'A 更贴合任务。',
  divergences: ['意象不同'],
});

describe('fisherYatesShuffle', () => {
  it('is deterministic for a given seed and a permutation of the input', () => {
    const arr = [1, 2, 3, 4, 5, 6];
    const a = fisherYatesShuffle([...arr], seededRng(42));
    const b = fisherYatesShuffle([...arr], seededRng(42));
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(arr);
    expect(fisherYatesShuffle([], seededRng(1))).toEqual([]);
    expect(fisherYatesShuffle([7], seededRng(1))).toEqual([7]);
  });
});

describe('anonymize', () => {
  it('assigns labels in shuffled order and keeps the audit orderMap', () => {
    const { options, orderMap } = anonymize(CANDIDATES, seededRng(7));
    expect(options.map((o) => o.label)).toEqual(['A', 'B']);
    expect(options).toHaveLength(2);
    // Every candidate appears exactly once in the audit map, with its true identity.
    const bySeat = new Map(orderMap.map((e) => [e.seatId, e]));
    expect([...bySeat.keys()].sort()).toEqual(['s1', 's2']);
    for (const o of options) {
      const entry = orderMap.find((e) => e.label === o.label)!;
      expect(entry.modelKey).toMatch(/^model-/);
      expect(CANDIDATES.find((c) => c.seatId === entry.seatId)!.content).toBe(o.content);
    }
  });

  it('rejects more candidates than labels', () => {
    const six = Array.from({ length: 6 }, (_, i) => cand(`s${i}`, 'm', `c${i}`));
    expect(() => anonymize(six)).toThrow(/at most 5/);
  });
});

describe('buildJudgePrompt / VerdictSchema', () => {
  it('returns system+user messages without leaking model identity', () => {
    const messages = buildJudgePrompt(TASK, '内容A', '内容B');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(TASK);
    expect(messages[1].content).toContain('内容A');
    expect(messages[1].content).toContain('内容B');
    expect(messages[1].content).not.toContain('model-x');
  });

  it('accepts a valid verdict and rejects extra fields / out-of-range values', () => {
    expect(VerdictSchema.safeParse(JSON.parse(VALID_VERDICT)).success).toBe(true);
    expect(VerdictSchema.safeParse({ ...JSON.parse(VALID_VERDICT), extra: 1 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...JSON.parse(VALID_VERDICT), confidence: 1.5 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...JSON.parse(VALID_VERDICT), winner: 'C' }).success).toBe(false);
  });
});

describe('judgePair', () => {
  it('returns a parsed verdict with confidence in range', async () => {
    const { callModel } = judgeModel([VALID_VERDICT]);
    const result = await judgePair(callModel, TASK, CANDIDATES, { judgeSeat: judgeSeat() });
    expect(result.error).toBeUndefined();
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.winner).toBe('A');
    expect(result.verdict!.confidence).toBeGreaterThanOrEqual(0);
    expect(result.verdict!.confidence).toBeLessThanOrEqual(1);
    expect(result.selfJudged).toBe(false); // judge-m != winner's model
    expect(result.orderMap).toHaveLength(2);
  });

  it('repairs invalid JSON with one retry', async () => {
    const { callModel, calls } = judgeModel(['我觉得A更好！', VALID_VERDICT]);
    const result = await judgePair(callModel, TASK, CANDIDATES, { judgeSeat: judgeSeat() });
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.winner).toBe('A');
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1)!.content).toContain('不符合 JSON schema');
  });

  it('returns verdict null after two invalid outputs instead of throwing', async () => {
    const { callModel, calls } = judgeModel(['垃圾输出1', '垃圾输出2']);
    const result = await judgePair(callModel, TASK, CANDIDATES, { judgeSeat: judgeSeat() });
    expect(result.verdict).toBeNull();
    expect(result.error).toBe('schema-fail-after-retry');
    expect(result.orderMap).toHaveLength(2); // candidates preserved via audit map
    expect(calls).toHaveLength(2); // exactly one retry
  });

  it('flags selfJudged when the judge model equals the winner model', async () => {
    const { callModel } = judgeModel([VALID_VERDICT]);
    const pair = [
      cand('s1', 'judge-m', '内容一'),
      cand('s2', 'model-y', '内容二'),
    ];
    const result = await judgePair(callModel, TASK, pair, {
      judgeSeat: judgeSeat('judge-m'),
      rng: () => 0, // j=0 -> swap: [s2, s1]; label A = s2(model-y), label B = s1(judge-m)
    });
    // winner A -> model-y, so not self-judged even though judge-m is in the pair.
    expect(result.selfJudged).toBe(false);
  });

  it('marks selfJudged=true when the same model wins and cannot be avoided', async () => {
    const { callModel } = judgeModel([VALID_VERDICT]);
    const allSameModel = [cand('s1', 'judge-m', '甲'), cand('s2', 'judge-m', '乙')];
    const result = await judgePair(callModel, TASK, allSameModel, {
      judgeSeat: judgeSeat('judge-m'),
      rng: () => 0,
    });
    // Both candidates share the judge's model — unavoidable self-evaluation.
    expect(result.selfJudged).toBe(true);
    expect(result.verdict).not.toBeNull();
  });

  it('prefers foreign-model candidates when the pool allows a non-self pair', async () => {
    const { callModel } = judgeModel([VALID_VERDICT]);
    const pool = [cand('s1', 'judge-m', '自己'), cand('s2', 'model-y', '乙'), cand('s3', 'model-z', '丙')];
    const result = await judgePair(callModel, TASK, pool, {
      judgeSeat: judgeSeat('judge-m'),
      rng: () => 0,
    });
    expect(result.selfJudged).toBe(false);
    expect(result.orderMap.map((e) => e.modelKey).sort()).toEqual(['model-y', 'model-z']);
  });

  it('requires at least two candidates', async () => {
    const { callModel } = judgeModel([]);
    await expect(
      judgePair(callModel, TASK, [CANDIDATES[0]], { judgeSeat: judgeSeat() }),
    ).rejects.toThrow(/at least 2/);
  });
});
