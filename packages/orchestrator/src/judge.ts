import type { CallModel, ChatMessage, SeatConfig } from './types';
import { VerdictSchema, buildJudgePrompt, type Verdict } from './judge-schema';

/** In-place Fisher–Yates shuffle; rng injectable for deterministic tests. */
export function fisherYatesShuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // Both indices are in bounds for rng values in [0, 1).
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export interface JudgeCandidate {
  seatId: string;
  modelKey: string;
  content: string;
}

export type OptionLabel = 'A' | 'B' | 'C' | 'D' | 'E';

const LABELS: OptionLabel[] = ['A', 'B', 'C', 'D', 'E'];

export interface AnonymizedOption {
  label: OptionLabel;
  content: string;
}

/** Audit mapping: label -> real seat/model, kept for every experiment. */
export interface OrderMapEntry {
  label: OptionLabel;
  seatId: string;
  modelKey: string;
}

export interface AnonymizeResult {
  options: AnonymizedOption[];
  orderMap: OrderMapEntry[];
}

/** Assigns shuffled labels A/B/... to candidates; the judge only ever sees labels. */
export function anonymize(candidates: JudgeCandidate[], rng: () => number = Math.random): AnonymizeResult {
  if (candidates.length > LABELS.length) {
    throw new Error(`anonymize supports at most ${LABELS.length} candidates, got ${candidates.length}`);
  }
  const shuffled = fisherYatesShuffle([...candidates], rng);
  return {
    options: shuffled.map((c, i) => ({ label: LABELS[i]!, content: c.content })),
    orderMap: shuffled.map((c, i) => ({ label: LABELS[i]!, seatId: c.seatId, modelKey: c.modelKey })),
  };
}

/** Extracts the first JSON object from a model reply (tolerates code fences / prose). */
function extractJson(text: string): unknown {
  const direct = zodParseCandidate(text);
  if (direct !== undefined) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return zodParseCandidate(text.slice(start, end + 1));
  return undefined;
}

function zodParseCandidate(s: string): unknown | undefined {
  const t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface JudgePairOptions {
  judgeSeat: SeatConfig;
  rng?: () => number;
  signal?: AbortSignal;
}

export interface JudgePairResult {
  verdict: Verdict | null;
  orderMap: OrderMapEntry[];
  /** True when the judge's own model is one of the judged candidates (could not be avoided). */
  selfJudged: boolean;
  error?: 'schema-fail-after-retry';
}

/**
 * Picks the two candidates to judge. Self-evaluation guard: if the judge's
 * modelKey matches a candidate, prefer candidates from other models when the
 * pool allows a full pair; otherwise fall through and flag selfJudged.
 */
function pickPair(candidates: JudgeCandidate[], judgeModelKey: string): [JudgeCandidate, JudgeCandidate] {
  if (candidates.length < 2) {
    throw new Error(`judgePair requires at least 2 candidates, got ${candidates.length}`);
  }
  const foreign = candidates.filter((c) => c.modelKey !== judgeModelKey);
  if (foreign.length >= 2) return [foreign[0]!, foreign[1]!];
  return [candidates[0]!, candidates[1]!];
}

/**
 * Judges the top two candidates anonymously. One schema-repair retry on parse
 * failure; after a second failure returns verdict null (no fabricated result —
 * the caller keeps the candidates and records the no-verdict outcome).
 * Does not emit events; the caller decides what to emit from the returned data.
 */
export async function judgePair(
  callModel: CallModel,
  task: string,
  candidates: JudgeCandidate[],
  opts: JudgePairOptions,
): Promise<JudgePairResult> {
  const rng = opts.rng ?? Math.random;
  const pair = pickPair(candidates, opts.judgeSeat.modelKey);
  const { options, orderMap } = anonymize(pair, rng);
  // anonymize preserves the two entries selected by pickPair.
  const basePrompt = buildJudgePrompt(task, options[0]!.content, options[1]!.content);
  const callOpts = { signal: opts.signal };

  const first = await callModel(opts.judgeSeat, basePrompt, callOpts);
  let parsed = VerdictSchema.safeParse(extractJson(first));
  if (parsed.success) {
    return { verdict: parsed.data, orderMap, selfJudged: computeSelfJudged(parsed.data.winner, orderMap, opts.judgeSeat.modelKey, pair) };
  }

  // One repair retry: tell the model its last output failed the schema.
  const repairPrompt: ChatMessage[] = [
    ...basePrompt,
    { role: 'assistant', content: first },
    {
      role: 'user',
      content:
        `你上次输出不符合 JSON schema（错误：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}）。` +
        '请重新只输出一个合法的 JSON 对象，不要包含任何其他文字。',
    },
  ];
  const second = await callModel(opts.judgeSeat, repairPrompt, callOpts);
  parsed = VerdictSchema.safeParse(extractJson(second));
  if (parsed.success) {
    return { verdict: parsed.data, orderMap, selfJudged: computeSelfJudged(parsed.data.winner, orderMap, opts.judgeSeat.modelKey, pair) };
  }

  return { verdict: null, orderMap, selfJudged: computeSelfJudged('tie', orderMap, opts.judgeSeat.modelKey, pair), error: 'schema-fail-after-retry' };
}

/**
 * selfJudged = the winning option was produced by the judge's own model.
 * 'tie' counts as self-judged only if a same-model candidate is in the pair.
 */
function computeSelfJudged(
  winner: 'A' | 'B' | 'tie',
  orderMap: OrderMapEntry[],
  judgeModelKey: string,
  pair: [JudgeCandidate, JudgeCandidate],
): boolean {
  const involvesSelf = pair.some((c) => c.modelKey === judgeModelKey);
  if (!involvesSelf) return false;
  if (winner === 'tie') return true;
  const winning = orderMap.find((e) => e.label === winner);
  return winning?.modelKey === judgeModelKey;
}
