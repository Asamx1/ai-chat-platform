import type { ChunkConfig, ChunkInput, ChunkResult, ChunkStrategy, StrategyName } from './types';
import { fixedStrategy } from './fixed';
import { recursiveStrategy } from './recursive';
import { structureStrategy } from './structure';

const registry = new Map<StrategyName, ChunkStrategy>();

/** Register a stateless strategy; duplicate names are rejected. */
export function registerStrategy(strategy: ChunkStrategy): void {
  if (registry.has(strategy.name)) throw new Error(`Duplicate chunk strategy: ${strategy.name}`);
  registry.set(strategy.name, strategy);
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

registerStrategy(fixedStrategy);
registerStrategy(recursiveStrategy);
registerStrategy(structureStrategy);
