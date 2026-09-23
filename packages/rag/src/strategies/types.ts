export type Part = { text: string };

/** Normalize line endings; offsets are computed over this normalized text. */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

export type StrategyName = 'fixed' | 'recursive' | 'structure' | 'semantic';

/**
 * All sizes are Unicode code point counts over the normalized, newline-joined text,
 * matching the offset semantics of the legacy `chunk()` entry point.
 */
export type ChunkConfig = {
  childMin: number;
  childTarget: number;
  childMax: number;
  childOverlap: number;
  parentMax: number;
  fixedSize: number;
  fixedOverlap: number;
  parentChild: boolean;
  /** Cosine similarity below this value confirms a semantic boundary. */
  semanticThreshold?: number;
  /** Number of adjacent units on each side of a candidate boundary. */
  semanticNeighborhood?: number;
};

export type ChunkInput = { parts: Part[]; mime: string };

export type ChunkKind = 'PARENT' | 'CHILD' | 'STANDALONE';

export type ChunkResult = {
  /** Stable key unique within one plan; parents are referenced by their key. */
  key: string;
  parentId: string | null;
  kind: ChunkKind;
  ordinal: number;
  start: number;
  end: number;
  text: string;
  headingPath: string[];
};

export type ChunkStrategy = {
  readonly name: StrategyName;
  chunk(doc: ChunkInput, config: Readonly<ChunkConfig>): ChunkResult[];
};

export type PlanStats = {
  strategy: string;
  requestedStrategy: string;
  effectiveStrategy: string;
  units: number;
  boundaries: number;
  mergedBoundaries: number;
  degradeReason?: string;
  timings: { embedMs: number; planMs: number };
};

export type PlanContext = {
  embedBatch(texts: string[]): Promise<number[][]>;
  signal?: AbortSignal;
  embeddingModel: string;
  onStats?: (stats: PlanStats) => void;
};

export type PlanChunksAsync = (input: ChunkInput, strategy: string, config: ChunkConfig, context: PlanContext) => Promise<ChunkResult[]>;

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  childMin: 128,
  childTarget: 256,
  childMax: 384,
  childOverlap: 32,
  parentMax: 1500,
  fixedSize: 512,
  fixedOverlap: 50,
  parentChild: true,
};

export function validateChunkConfig(config: Readonly<ChunkConfig>): void {
  const { childMin, childTarget, childMax, childOverlap, parentMax, fixedSize, fixedOverlap } = config;
  const ints = [childMin, childTarget, childMax, childOverlap, parentMax, fixedSize, fixedOverlap];
  if (ints.some(v => !Number.isSafeInteger(v))) throw new RangeError('Invalid chunk config');
  if (!(0 < childMin && childMin <= childTarget && childTarget <= childMax && childMax <= parentMax)) {
    throw new RangeError('Invalid chunk config');
  }
  if (!(0 <= childOverlap && childOverlap < childMin)) throw new RangeError('Invalid chunk config');
  if (!(fixedSize > 0 && 0 <= fixedOverlap && fixedOverlap < fixedSize)) throw new RangeError('Invalid chunk window');
  if (config.semanticThreshold !== undefined && (!Number.isFinite(config.semanticThreshold) || config.semanticThreshold < -1 || config.semanticThreshold > 1)) throw new RangeError('Invalid semanticThreshold');
  if (config.semanticNeighborhood !== undefined && (!Number.isSafeInteger(config.semanticNeighborhood) || config.semanticNeighborhood < 1)) throw new RangeError('Invalid semanticNeighborhood');
}

/** Normalized full text exactly as the legacy pipeline would join it. */
export function fullText(doc: ChunkInput): string {
  return normalize(doc.parts.map(p => p.text).join('\n'));
}
