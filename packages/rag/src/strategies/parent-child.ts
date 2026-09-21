import type { ChunkConfig, ChunkKind, ChunkResult } from './types';

/** A planned block over absolute code point offsets of the normalized full text. */
export type Block = {
  start: number;
  end: number;
  headingPath: string[];
  kind: ChunkKind;
  /** Index into the block array of the parent block, or null for top level. */
  parent: number | null;
};

export type Range = { start: number; end: number };

/**
 * Assign keys, ordinals and texts. Retrieval blocks (CHILD/STANDALONE) are numbered
 * first in text order, then parents, so ordinals stay document-unique.
 */
export function finalize(blocks: Block[], cps: string[]): ChunkResult[] {
  const parentEntries = blocks.map((b, i) => ({ b, i })).filter(x => x.b.kind === 'PARENT');
  const parentKeys = new Map<number, string>();
  parentEntries.forEach((x, n) => parentKeys.set(x.i, `parent-${n}`));
  const results: ChunkResult[] = [];
  let ordinal = 0;
  const retrieval = blocks
    .map((b, i) => ({ b, i }))
    .filter(x => x.b.kind !== 'PARENT')
    .sort((a, b) => a.b.start - b.b.start || a.b.end - b.b.end);
  for (const { b, i } of retrieval) {
    results.push({
      key: `child-${ordinal}`,
      parentId: b.parent == null ? null : parentKeys.get(b.parent) ?? null,
      kind: b.kind,
      ordinal: ordinal++,
      start: b.start,
      end: b.end,
      text: cps.slice(b.start, b.end).join(''),
      headingPath: b.headingPath,
    });
  }
  for (const { b, i } of parentEntries) {
    results.push({
      key: parentKeys.get(i)!,
      parentId: null,
      kind: 'PARENT',
      ordinal: ordinal++,
      start: b.start,
      end: b.end,
      text: cps.slice(b.start, b.end).join(''),
      headingPath: b.headingPath,
    });
  }
  return results;
}

export function validateResults(results: ChunkResult[], cps: string[], config: Readonly<ChunkConfig>): void {
  const byKey = new Map(results.map(r => [r.key, r]));
  for (const r of results) {
    if (r.text !== cps.slice(r.start, r.end).join('')) {
      throw new Error(`chunk ${r.key} text does not match its offsets`);
    }
    if (r.kind === 'CHILD') {
      const parent = r.parentId == null ? null : byKey.get(r.parentId);
      if (!parent || parent.kind !== 'PARENT') throw new Error(`chunk ${r.key} has no valid parent`);
      if (r.start < parent.start || r.end > parent.end) {
        throw new Error(`chunk ${r.key} escapes its parent interval`);
      }
      if (config.parentChild && r.end - r.start > Math.max(config.childMax, config.fixedSize)) {
        throw new Error(`chunk ${r.key} exceeds child window`);
      }
    } else if (r.kind === 'PARENT') {
      if (r.parentId !== null) throw new Error(`parent ${r.key} must not have a parent`);
      if (r.end - r.start > config.parentMax) throw new Error(`parent ${r.key} exceeds parentMax`);
    } else if (r.parentId !== null) {
      throw new Error(`standalone chunk ${r.key} must not have a parent`);
    }
  }
}

/** Split [start, end) into windows of `size` stepping by `size - overlap`, clipped to the range. */
export function fixedWindows(start: number, end: number, size: number, overlap: number): Range[] {
  const ranges: Range[] = [];
  for (let s = start; s < end; s += size - overlap) {
    const e = Math.min(s + size, end);
    ranges.push({ start: s, end: e });
    if (e === end) break;
  }
  return ranges;
}

/** Split [start, end) into segments at each occurrence of `sep`; the delimiter stays with the preceding segment. */
export function splitKeeping(start: number, end: number, sep: string, cps: string[]): Range[] {
  const ranges: Range[] = [];
  let segStart = start;
  for (let i = start; i < end; i++) {
    if (cps[i] === sep[0]) {
      let match = true;
      for (let j = 1; j < sep.length; j++) {
        if (i + j >= end || cps[i + j] !== sep[j]) { match = false; break; }
      }
      if (match) {
        ranges.push({ start: segStart, end: Math.min(i + sep.length, end) });
        segStart = Math.min(i + sep.length, end);
        i += sep.length - 1;
      }
    }
  }
  if (segStart < end) ranges.push({ start: segStart, end });
  return ranges.filter(r => r.end > r.start);
}

/** Greedily pack unit ranges up to `target`, never exceeding `max`; oversized units are hard-split. */
export function packUnits(units: Range[], target: number, max: number, overlap: number): Range[] {
  const packed: Range[] = [];
  let cur: Range | null = null;
  const flush = () => {
    if (cur) packed.push(cur);
    cur = null;
  };
  for (const u of units) {
    const len = u.end - u.start;
    if (len > max) {
      flush();
      for (const w of fixedWindows(u.start, u.end, max, Math.min(overlap, max - 1))) packed.push(w);
      continue;
    }
    if (cur && cur.end - cur.start + len > max) flush();
    cur = cur ? { start: cur.start, end: u.end } : { ...u };
    if (cur.end - cur.start >= target) flush();
  }
  flush();
  // Add overlap by extending each chunk backwards into the previous chunk (same parent region).
  for (let i = 1; i < packed.length; i++) {
    const prev = packed[i - 1];
    const cur = packed[i];
    if (!prev || !cur) continue;
    if (prev.end - overlap > cur.start) continue; // no gap to bridge
    packed[i] = { start: Math.max(cur.start, prev.end - overlap), end: cur.end };
  }
  return packed.filter(r => r.end > r.start);
}

/** Pack paragraphs (blank-line separated) into parent regions no longer than parentMax. */
export function parentRegions(start: number, end: number, cps: string[], parentMax: number): Range[] {
  const paragraphs = splitKeeping(start, end, '\n\n', cps);
  const units = paragraphs.length > 1 ? paragraphs : splitKeeping(start, end, '\n', cps);
  return packUnits(units, parentMax, parentMax, 0);
}
