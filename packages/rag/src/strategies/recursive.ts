import { finalize, packUnits, parentRegions, splitKeeping, validateResults, type Block, type Range } from './parent-child';
import { fullText, validateChunkConfig, type ChunkConfig, type ChunkInput, type ChunkResult, type ChunkStrategy } from './types';

const SEPARATORS = ['\n## ', '\n', '。', ' '];

/**
 * Recursive character split: fall back through the separator list, then merge the
 * resulting pieces up to childTarget while staying under childMax.
 */
function recursiveRanges(start: number, end: number, cps: string[], seps: string[], config: Readonly<ChunkConfig>): Range[] {
  if (end - start <= config.childMax) return [{ start, end }];
  for (let s = 0; s < seps.length; s++) {
    const sep = seps[s];
    if (sep === undefined) continue;
    const pieces = splitKeeping(start, end, sep, cps);
    if (pieces.length <= 1) continue;
    const units = pieces.flatMap(p => recursiveRanges(p.start, p.end, cps, seps.slice(s + 1), config));
    return packUnits(units, config.childTarget, config.childMax, config.childOverlap);
  }
  // No separator matched anywhere: hard window split.
  return packUnits([{ start, end }], config.childTarget, config.childMax, config.childOverlap);
}

export function splitRecursive(doc: ChunkInput, config: Readonly<ChunkConfig>): ChunkResult[] {
  validateChunkConfig(config);
  const cps = Array.from(fullText(doc));
  if (!cps.join('').trim()) return [];
  const blocks: Block[] = [];
  if (!config.parentChild) {
    for (const r of recursiveRanges(0, cps.length, cps, SEPARATORS, config)) {
      blocks.push({ ...r, headingPath: [], kind: 'STANDALONE', parent: null });
    }
  } else {
    for (const region of parentRegions(0, cps.length, cps, config.parentMax)) {
      const parentIndex = blocks.length;
      blocks.push({ ...region, headingPath: [], kind: 'PARENT', parent: null });
      for (const r of recursiveRanges(region.start, region.end, cps, SEPARATORS, config)) {
        blocks.push({ ...r, headingPath: [], kind: 'CHILD', parent: parentIndex });
      }
    }
  }
  const results = finalize(blocks, cps);
  validateResults(results, cps, config);
  return results;
}

export const recursiveStrategy: ChunkStrategy = { name: 'recursive', chunk: splitRecursive };
