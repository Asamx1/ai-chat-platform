import type { RunEventType } from '@aichat/contracts';
import type { CallModel, EmitFn, EngineEvent, Phase, RunContext, Strategy, StrategyResult } from './types';

export interface EnginePorts {
  /** Persist/forward one event; the engine assigns seq. */
  emit(event: EngineEvent): void;
  /** Called on phase transitions; the engine owns phase state. */
  updatePhase(phase: Phase): void;
  /** Model access, injected per environment (worker: real provider, tests: fake). */
  callModel: CallModel;
}

/** Base context without callModel — the engine injects it. */
export type StrategyContextInput = Omit<RunContext, 'callModel'>;

const PHASE_BY_EVENT: Partial<Record<RunEventType, Phase>> = {
  'run.planning': 'PLANNING',
  'provider.call.started': 'ROUND',
  'provider.delta': 'ROUND',
  'provider.call.completed': 'ROUND',
  'run.round.completed': 'ROUND',
  'judge.result': 'JUDGING',
};

export function createEngine(ports: EnginePorts) {
  return {
    async runStrategy(
      strategy: Strategy,
      ctxInput: StrategyContextInput,
    ): Promise<StrategyResult> {
      let seq = 0;
      let phase: Phase | undefined;
      const emit: EmitFn = (type, payload = {}, explicitPhase) => {
        const next = explicitPhase ?? PHASE_BY_EVENT[type];
        if (next && next !== phase) {
          phase = next;
          ports.updatePhase(next);
        }
        ports.emit({ seq: seq++, type, payload });
      };

      const ctx: RunContext = { ...ctxInput, callModel: ports.callModel };
      try {
        const result = await strategy.run(ctx, emit);
        emit('run.succeeded', {
          degraded: result.degraded ?? false,
          reasons: result.reasons ?? [],
        });
        return result;
      } catch (error) {
        emit('run.failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}
