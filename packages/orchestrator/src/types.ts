import type { RunEventType } from '@aichat/contracts';

/** Collaboration phase of a run, derived from the strategy's event stream. */
export type Phase = 'PLANNING' | 'ROUND' | 'JUDGING' | 'SYNTHESIZING';

/** A single model seat participating in a collaboration run. */
export interface SeatConfig {
  seatId: string;
  modelKey: string;
  role: string;
  systemPrompt: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Call a seat's model. Injected by the engine (worker wires a real provider, tests wire a fake). */
export type CallModel = (
  seat: SeatConfig,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal | undefined },
) => Promise<string>;

/** Everything a strategy needs to execute; callModel is injected by the engine. */
export interface RunContext {
  runId: string;
  seats: SeatConfig[];
  userContent: string;
  maxRounds?: number | undefined;
  callModel: CallModel;
}

/** Reuses the contracts RunEvent envelope shape (seq/type/payload). */
export interface EngineEvent {
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
}

export interface StrategyResult {
  assistantMessageContent: string;
  degraded?: boolean | undefined;
  reasons?: string[] | undefined;
}

/** emit provided by the engine: assigns seq and derives phase updates. */
export type EmitFn = (
  type: RunEventType,
  payload?: Record<string, unknown>,
  phase?: Phase,
) => void;

/** Describes the steps a strategy will take (informational; the engine progresses by phase). */
export interface Plan {
  steps: string[];
}

export interface Strategy<Ctx = RunContext> {
  mode: 'GROUP' | 'CONSENSUS' | 'DEBATE';
  plan(ctx: Ctx): Plan;
  run(ctx: Ctx, emit: EmitFn): Promise<StrategyResult>;
}
