import type { ChunkConfig, ChunkInput, ChunkResult, ChunkStrategy, PlanChunksAsync, StrategyName } from './types';
import { fixedStrategy } from './fixed';
import { recursiveStrategy } from './recursive';
import { structureStrategy } from './structure';
import { SemanticEmbeddingFailure, splitSemantic } from './semantic';

const registry = new Map<StrategyName, ChunkStrategy>();

/** Register a stateless strategy; duplicate names are rejected. */
export function registerStrategy(strategy: ChunkStrategy): void {
  if (registry.has(strategy.name)) throw new Error(`Duplicate chunk strategy: ${strategy.name}`);
  registry.set(strategy.name, strategy);
}

export function isStrategyName(name: string): name is StrategyName {
  return Array.from(registry.keys()).some(key => key === name);
}

export function getStrategy(name: StrategyName): ChunkStrategy {
  const strategy = registry.get(name);
  if (!strategy) throw new RangeError(`Unknown chunk strategy: ${name}`);
  return strategy;
}

/** Dispatch through the registry; unknown strategies are rejected, never silently substituted. */
export function planChunks(input: ChunkInput, name: StrategyName, config: Readonly<ChunkConfig>): ChunkResult[] {
  return getStrategy(name).chunk(input, config);
}

/** Synchronous strategies retain their original implementation and result shape. */
export const planChunksAsync: PlanChunksAsync = async (input, strategy, config, context) => {
  context.signal?.throwIfAborted();
  if (!isStrategyName(strategy)) throw new RangeError(`Unknown chunk strategy: ${strategy}`);
  if (strategy !== 'semantic') {
    const started = Date.now();
    const results = planChunks(input, strategy, config);
    context.signal?.throwIfAborted();
    context.onStats?.({ strategy, requestedStrategy: strategy, effectiveStrategy: strategy, units: 0, boundaries: 0, mergedBoundaries: 0, timings: { embedMs: 0, planMs: Date.now() - started } });
    return results;
  }
  const started = Date.now();
  try {
    return await splitSemantic(input, config, context);
  } catch (error) {
    context.signal?.throwIfAborted();
    // Invalid configuration and permanent embedding errors must use the normal error path.
    if (!(error instanceof SemanticEmbeddingFailure)) throw error;
    const results = planChunks(input, 'structure', config);
    context.onStats?.({ strategy: 'structure', requestedStrategy: 'semantic', effectiveStrategy: 'structure', units: 0, boundaries: 0, mergedBoundaries: 0, degradeReason: error instanceof Error ? error.message : String(error), timings: { embedMs: Date.now() - started, planMs: Date.now() - started } });
    return results;
  }
};

/** Check cancellation at the final write boundary; storePlan also verifies the lease in SQL. */
export async function writeUnlessAborted<T>(signal: AbortSignal, write: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return write();
}

registerStrategy(fixedStrategy);
registerStrategy(recursiveStrategy);
registerStrategy(structureStrategy);
registerStrategy({ name: 'semantic', chunk: () => { throw new Error('semantic requires planChunksAsync'); } });
