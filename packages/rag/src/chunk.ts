import { getStrategy } from './strategies/registry';
import { DEFAULT_CHUNK_CONFIG, type ChunkConfig, type ChunkInput, type ChunkResult, type StrategyName } from './strategies/types';

export type Part = { text: string };
export type Slice = { ordinal: number; start: number; end: number; text: string };
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}
/** Offsets count Unicode code points in the normalized, newline-joined text. */
export function chunk(parts: Part[], size = 512, overlap = 50): Slice[] {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(overlap) || size <= 0 || overlap < 0 || overlap >= size) {
    throw new RangeError('Invalid chunk window');
  }
  const config: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, fixedSize: size, fixedOverlap: overlap, parentChild: false };
  // Route through the fixed strategy so the legacy entry and the registry stay identical.
  return getStrategy('fixed')
    .chunk({ parts, mime: 'text/plain' }, config)
    .map(r => ({ ordinal: r.ordinal, start: r.start, end: r.end, text: r.text }));
}

/**
 * Strategy-aware entry point driven by Document.chunkStrategy. Unknown strategies throw;
 * the default is `structure` per the M9 design.
 */
export function chunkDocument(
  doc: ChunkInput,
  strategy: StrategyName = 'structure',
  config: Readonly<ChunkConfig> = DEFAULT_CHUNK_CONFIG,
): ChunkResult[] {
  return getStrategy(strategy).chunk(doc, config);
}

export type { ChunkConfig, ChunkInput, ChunkResult, StrategyName };
