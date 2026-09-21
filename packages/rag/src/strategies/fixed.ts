import { finalize, fixedWindows, parentRegions, validateResults, type Block, type Range } from './parent-child';
import { fullText, validateChunkConfig, type ChunkConfig, type ChunkInput, type ChunkResult, type ChunkStrategy } from './types';

/** Fixed-window splitter: with parentChild disabled this is byte-for-byte the legacy chunk() behavior. */
export function splitFixed(doc: ChunkInput, config: Readonly<ChunkConfig>): ChunkResult[] {
  validateChunkConfig(config);
  const cps = Array.from(fullText(doc));
  if (!cps.join('').trim()) return [];
  const blocks: Block[] = [];
  if (!config.parentChild) {
    for (const w of fixedWindows(0, cps.length, config.fixedSize, config.fixedOverlap)) {
      blocks.push({ ...w, headingPath: [], kind: 'STANDALONE', parent: null });
    }
  } else {
    const regions = parentRegions(0, cps.length, cps, config.parentMax);
    regions.forEach((region: Range) => {
      const parentIndex = blocks.length;
      blocks.push({ ...region, headingPath: [], kind: 'PARENT', parent: null });
      for (const w of fixedWindows(region.start, region.end, config.fixedSize, config.fixedOverlap)) {
        blocks.push({ ...w, headingPath: [], kind: 'CHILD', parent: parentIndex });
      }
    });
  }
  const results = finalize(blocks, cps);
  validateResults(results, cps, config);
  return results;
}

export const fixedStrategy: ChunkStrategy = { name: 'fixed', chunk: splitFixed };
