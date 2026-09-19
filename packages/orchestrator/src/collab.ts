/**
 * 高层协作编排入口（E3 collab-runner 期望的 API 形态）。
 * 基于 engine + strategies 内核的组合封装：
 *   runOrchestration({mode, seats, userContent, callModel, signal, shouldCancel})
 *     → AsyncIterable<CollabEvent>
 * CollabEvent: {type:'planning'|'seat.started'|'seat.completed'|'round.completed'|'final'|...}
 * 取代 collab-runner 自行拼装 engine 的细节。
 */
import { groupStrategy } from './strategies/group';
import { consensusStrategy } from './strategies/consensus';
import type { SeatConfig, CallModel, StrategyResult } from './types';

/** collab-runner 使用的席位形态（RunParticipantSnapshot 行映射）。 */
export interface OrchestratorSeat {
  seatId: string;
  modelKey: string;
  role: string;
  systemPrompt: string;
}

export class CollabCancelledError extends Error {
  constructor() {
    super('collab run cancelled');
    this.name = 'CollabCancelledError';
  }
}

export type CollabEvent =
  | { type: 'planning'; mode: string; seats: number }
  | { type: 'seat.started'; seatId: string }
  | { type: 'seat.completed'; seatId: string; output: string; tokens?: number }
  | { type: 'round.completed'; round: number; seatsDone: number }
  | { type: 'degraded'; seatId: string; reason: string }
  | { type: 'final'; output: string; degraded?: boolean; reasons?: string[] };

export interface RunOrchestrationOptions {
  mode: 'GROUP' | 'CONSENSUS' | 'DEBATE';
  seats: OrchestratorSeat[];
  userContent: string;
  tokenBudget?: number;
  maxRounds?: number;
  callModel: CallModel;
  signal?: AbortSignal;
  shouldCancel?: () => Promise<boolean>;
}

const DEGRADE_EVENTS = 4; // 每 4 次取消检查点产出一次 degraded 事件查点

export async function* runOrchestration(
  opts: RunOrchestrationOptions,
): AsyncGenerator<CollabEvent> {
  const { mode, seats, userContent, callModel, signal, shouldCancel } = opts;

  yield { type: 'planning', mode, seats: seats.length };

  const maybeCancelled = async () => {
    if (signal?.aborted) return true;
    if (shouldCancel && (await shouldCancel())) return true;
    return false;
  };

  // 内部策略调用：把 E1 内核策略的事件翻译为 CollabEvent
  const toSeat = (s: OrchestratorSeat): SeatConfig => ({
    seatId: s.seatId,
    modelKey: s.modelKey,
    role: s.role,
    systemPrompt: s.systemPrompt,
  });

  const events: CollabEvent[] = [];
  let result: StrategyResult | null = null;

  const wrappedCallModel: CallModel = async (seat, messages, callOpts) => {
    if (await maybeCancelled()) throw new CollabCancelledError();
    events.push({ type: 'seat.started', seatId: seat.seatId });
    // E3 collab-runner 的 callModel 签名是 (seat, prompt: string, signal?)：
    // 策略产出的完整 messages 数组压成单条 user 文本（system 已由 seat 携带）。
    const prompt = messages
      .filter((m) => m.role !== 'system')
      .map((m) => (m.role === 'assistant' ? `[${m.role}] ${m.content}` : m.content))
.join('\n\n');
    const output = await callModel(seat, prompt, callOpts?.signal);
    events.push({ type: 'seat.completed', seatId: seat.seatId, output });
    return output;
  };

  const emit = (type: string, payload: Record<string, unknown>) => {
    // E1 内核策略可能 emit 的事件透传（round 完成等）
    if (type === 'provider.call.completed' && payload.seatId) {
      // E1 内核的席位完成事件也映射为 seat.completed（wrappedCallModel 的补充路径）
      if (payload.failed) {
        events.push({ type: 'degraded', seatId: String(payload.seatId), reason: String(payload.reason ?? 'seat failed') });
      }
      return;
    }
    if (type === 'run.round.completed') {
      events.push({
        type: 'round.completed',
        round: Number(payload.round ?? 1),
        seatsDone: Number(payload.seatsDone ?? seats.length),
      });
    }
    if (type === 'seat.degraded' || type === 'run.degraded') {
      events.push({
        type: 'degraded',
        seatId: String(payload.seatId ?? '?'),
        reason: String(payload.reason ?? 'seat failed'),
      });
    }
  };

  if (mode === 'DEBATE') {
    // M4 落地；M3 显式拒绝而非静默降级（PLAN §7.3 能力协商原则）
    throw new Error('DEBATE strategy arrives in M4');
  }

  const strategy = mode === 'CONSENSUS' ? consensusStrategy : groupStrategy;

  result = await strategy.run(
    {
      runId: 'inline',
      seats: seats.map(toSeat),
      userContent,
      callModel: wrappedCallModel,
    },
    emit,
  );

  // 展平中间事件（策略已同步产出）
  for (const ev of events) yield ev;

  yield {
    type: 'final',
    output: result.assistantMessageContent,
    degraded: result.degraded,
    reasons: result.reasons,
  };
}
