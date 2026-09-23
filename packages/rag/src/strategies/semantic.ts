import { finalize, fixedWindows, validateResults, type Block, type Range } from './parent-child';
import { scanMarkdown } from './structure';
import { fullText, validateChunkConfig, type ChunkConfig, type ChunkInput, type ChunkResult, type PlanContext, type PlanStats } from './types';

type Unit = Range & { headingPath: string[]; semantic: boolean };

export class SemanticEmbeddingFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SemanticEmbeddingFailure';
  }
}

/** Every unit uses code point offsets in the normalized source. */
function unitsFor(input: ChunkInput, cps: string[]): Unit[] {
  const sections = input.mime === 'text/markdown' ? scanMarkdown(cps) : [{ start: 0, end: cps.length, headingPath: [] }];
  if (sections[0] && sections[0].start > 0) sections.unshift({ start: 0, end: sections[0].start, headingPath: [] });
  const units: Unit[] = [];
  for (const section of sections) {
    let pos = section.start;
    let fence = false;
    let tablePath: string[] | undefined;
    while (pos < section.end) {
      const lineEnd = Math.min(section.end, (cps.indexOf('\n', pos) < 0 ? section.end : cps.indexOf('\n', pos) + 1));
      const line = cps.slice(pos, lineEnd).join('');
      const fenced = /^\s*(```|~~~)/.test(line);
      if (fenced) fence = !fence;
      const table = !fence && /^\s*\|/.test(line);
      if (table && !tablePath) tablePath = [...section.headingPath, `Table: ${line.trim()}`];
      if (!table) tablePath = undefined;
      const structural = fence || fenced || table || /^\s*(?:[-*+]\s|\d+[.)]\s|>\s)/.test(line);
      if (structural) {
        units.push({ start: pos, end: lineEnd, headingPath: tablePath ?? section.headingPath, semantic: false });
      } else {
        // Keep punctuation and whitespace with the preceding sentence so no offset is lost.
        let start = pos;
        for (let i = pos; i < lineEnd; i++) {
          if (/[。！？.!?]/u.test(cps[i] ?? '') && i + 1 < lineEnd) {
            units.push({ start, end: i + 1, headingPath: section.headingPath, semantic: true });
            start = i + 1;
          }
        }
        if (start < lineEnd) units.push({ start, end: lineEnd, headingPath: section.headingPath, semantic: true });
      }
      pos = lineEnd;
    }
  }
  return units;
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) throw new Error('INVALID_SEMANTIC_EMBEDDING');
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('INVALID_SEMANTIC_EMBEDDING');
    dot += x * y; aa += x * x; bb += y * y;
  }
  if (!aa || !bb) throw new Error('INVALID_SEMANTIC_EMBEDDING');
  return dot / Math.sqrt(aa * bb);
}

function mean(vectors: number[][]): number[] {
  const result = [...(vectors[0] ?? [])].map(() => 0);
  for (const vector of vectors) for (let i = 0; i < result.length; i++) result[i] = (result[i] ?? 0) + (vector[i] ?? 0) / vectors.length;
  return result;
}

/** Build a plan and report semantic work through the caller's statistics hook. */
export async function splitSemantic(input: ChunkInput, config: Readonly<ChunkConfig>, context: PlanContext): Promise<ChunkResult[]> {
  validateChunkConfig(config);
  context.signal?.throwIfAborted();
  const started = Date.now();
  const cps = Array.from(fullText(input));
  if (!cps.join('').trim()) {
    context.onStats?.({ strategy: 'semantic', requestedStrategy: 'semantic', effectiveStrategy: 'semantic', units: 0, boundaries: 0, mergedBoundaries: 0, timings: { embedMs: 0, planMs: Date.now() - started } });
    return [];
  }
  const units = unitsFor(input, cps);
  const semantic = units.filter(u => u.semantic && cps.slice(u.start, u.end).join('').trim());
  const embedStarted = Date.now();
  let vectors: number[][];
  try {
    vectors = semantic.length ? await context.embedBatch(semantic.map(u => cps.slice(u.start, u.end).join(''))) : [];
    context.signal?.throwIfAborted();
    if (vectors.length !== semantic.length) throw new Error('INVALID_SEMANTIC_EMBEDDING_COUNT');
    for (const vector of vectors) cosine(vector, vector);
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'PermanentRagError') throw error;
    throw new SemanticEmbeddingFailure(error);
  }
  const embedMs = Date.now() - embedStarted;
  const byUnit = new Map(semantic.map((u, i) => [u, vectors[i]!]));
  const boundaries = new Set<number>();
  const radius = config.semanticNeighborhood ?? 2;
  for (let i = 1; i < units.length; i++) {
    const left = units[i - 1]!; const right = units[i]!;
    if (left.headingPath !== right.headingPath || left.semantic !== right.semantic) { boundaries.add(i); continue; }
    if (!left.semantic) continue;
    const before = units.slice(Math.max(0, i - radius), i).filter(u => byUnit.has(u)).map(u => byUnit.get(u)!);
    const after = units.slice(i, i + radius).filter(u => byUnit.has(u)).map(u => byUnit.get(u)!);
    if (before.length && after.length && cosine(mean(before), mean(after)) < (config.semanticThreshold ?? 0.75)) boundaries.add(i);
  }
  const groups: Unit[][] = [];
  let group: Unit[] = [];
  for (let i = 0; i < units.length; i++) {
    if (boundaries.has(i) && group.length) { groups.push(group); group = []; }
    group.push(units[i]!);
  }
  if (group.length) groups.push(group);
  let mergedBoundaries = 0;
  // A short group can be merged only when its own content cannot meet childMin.
  if (groups.length > 1 && groups[0]![groups[0]!.length - 1]!.end - groups[0]![0]!.start < config.childMin &&
      groups[0]![0]!.headingPath === groups[1]![0]!.headingPath &&
      groups[1]![groups[1]!.length - 1]!.end - groups[0]![0]!.start <= (config.parentChild ? config.parentMax : config.childMax)) {
    groups[1]!.unshift(...groups[0]!); groups.shift(); mergedBoundaries++;
  }
  for (let i = 1; i < groups.length;) {
    const current = groups[i]!;
    if (current[current.length - 1]!.end - current[0]!.start < config.childMin &&
        groups[i - 1]![0]!.headingPath === current[0]!.headingPath &&
        current[current.length - 1]!.end - groups[i - 1]![0]!.start <= (config.parentChild ? config.parentMax : config.childMax)) {
      groups[i - 1]!.push(...current); groups.splice(i, 1); mergedBoundaries++;
    } else i++;
  }
  const blocks: Block[] = [];
  for (const entry of groups) {
    const first = entry[0]!; const last = entry[entry.length - 1]!;
    const parentRanges = config.parentChild ? fixedWindows(first.start, last.end, config.parentMax, 0) : [{ start: first.start, end: last.end }];
    for (const parentRange of parentRanges) {
      const parentIndex = blocks.length;
      if (config.parentChild) blocks.push({ ...parentRange, headingPath: first.headingPath, kind: 'PARENT', parent: null });
      const clipped = entry.map(u => ({ start: Math.max(u.start, parentRange.start), end: Math.min(u.end, parentRange.end) })).filter(u => u.end > u.start);
      const childRanges: Range[] = [];
      let current: Range | undefined;
      for (const unit of clipped) {
        const pieces = fixedWindows(unit.start, unit.end, config.childMax, Math.min(config.childOverlap, config.childMax - 1));
        for (const piece of pieces) {
          if (current && (piece.end - current.start > config.childMax || current.end - current.start >= config.childTarget)) {
            childRanges.push(current); current = undefined;
          }
          current = current ? { start: current.start, end: piece.end } : { ...piece };
        }
      }
      if (current) childRanges.push(current);
      // Overlap stays inside the confirmed group and its parent interval.
      for (let i = 1; i < childRanges.length; i++) {
        const previous = childRanges[i - 1]!; const next = childRanges[i]!;
        next.start = Math.max(parentRange.start, previous.end - config.childOverlap, next.end - config.childMax);
      }
      for (const range of childRanges) blocks.push({ ...range, headingPath: first.headingPath, kind: config.parentChild ? 'CHILD' : 'STANDALONE', parent: config.parentChild ? parentIndex : null });
    }
  }
  const results = finalize(blocks, cps);
  validateResults(results, cps, config);
  const stats: PlanStats = { strategy: 'semantic', requestedStrategy: 'semantic', effectiveStrategy: 'semantic', units: units.length, boundaries: boundaries.size, mergedBoundaries, timings: { embedMs, planMs: Date.now() - started } };
  context.onStats?.(stats);
  return results;
}
