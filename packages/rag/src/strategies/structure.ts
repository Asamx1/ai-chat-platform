import { finalize, packUnits, parentRegions, splitKeeping, validateResults, type Block, type Range } from './parent-child';
import { fullText, validateChunkConfig, type ChunkConfig, type ChunkInput, type ChunkResult, type ChunkStrategy } from './types';

export type StructureSection = { start: number; end: number; headingPath: string[] };

const ATX = /^(#{1,6})[ \t]+(.*)$/;
const SETEXT_1 = /^=+[ \t]*$/;
const SETEXT_2 = /^-+[ \t]*$/;

/**
 * Scan markdown into heading-delimited sections. ATX and Setext headings are
 * recognized; `#` inside fenced code blocks is not treated as a heading.
 */
export function scanMarkdown(cps: string[]): StructureSection[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < cps.length; i++) if (cps[i] === '\n') lineStarts.push(i + 1);
  const lines = lineStarts.map((s, idx) => ({
    start: s,
    end: idx + 1 < lineStarts.length ? (lineStarts[idx + 1] ?? cps.length) : cps.length,
    text: cps.slice(s, idx + 1 < lineStarts.length ? (lineStarts[idx + 1] ?? cps.length) - 1 : cps.length).join(''),
  }));
  const sections: StructureSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: StructureSection | null = null;
  let fence: string | null = null;
  const push = (end: number) => {
    if (current) {
      current.end = end;
      if (current.end > current.start) sections.push(current);
    }
    current = null;
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const fenceMatch = line.text.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
    }
    if (fence) continue;
    const atx = line.text.match(ATX);
    let level: number | null = null;
    let title = '';
    if (atx) {
      level = atx[1]?.length ?? 0;
      title = (atx[2] ?? '').trim();
    } else if (li + 1 < lines.length && lines[li + 1]?.text.trim() !== '') {
      const next = lines[li + 1]?.text;
      if (next === undefined) continue;
      if (SETEXT_1.test(next) || SETEXT_2.test(next)) {
        level = SETEXT_1.test(next) ? 1 : 2;
        title = line.text.trim();
        li++;
      }
    }
    if (level == null || level === 0) continue;
    push(line.start);
    while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    current = { start: line.start, end: cps.length, headingPath: stack.map(h => h.title) };
  }
  push(cps.length);
  if (sections.length === 0) sections.push({ start: 0, end: cps.length, headingPath: [] });
  return sections;
}

function childUnits(start: number, end: number, cps: string[]): Range[] {
  const paragraphs = splitKeeping(start, end, '\n\n', cps);
  const base = paragraphs.length > 1 ? paragraphs : splitKeeping(start, end, '\n', cps);
  return base.flatMap(p => {
    const sentences = splitKeeping(p.start, p.end, '。', cps);
    return sentences.flatMap(s => (s.end - s.start > 1 ? splitKeeping(s.start, s.end, ' ', cps) : [s]));
  });
}

export function splitStructure(doc: ChunkInput, config: Readonly<ChunkConfig>): ChunkResult[] {
  validateChunkConfig(config);
  const cps = Array.from(fullText(doc));
  if (!cps.join('').trim()) return [];
  const isMarkdown = doc.mime === 'text/markdown';
  const sections = isMarkdown ? scanMarkdown(cps) : [{ start: 0, end: cps.length, headingPath: [] }];
  const blocks: Block[] = [];
  if (!config.parentChild) {
    for (const section of sections) {
      for (const r of packUnits(childUnits(section.start, section.end, cps), config.childTarget, config.childMax, config.childOverlap)) {
        blocks.push({ ...r, headingPath: section.headingPath, kind: 'STANDALONE', parent: null });
      }
    }
  } else {
    for (const section of sections) {
      for (const region of parentRegions(section.start, section.end, cps, config.parentMax)) {
        const parentIndex = blocks.length;
        blocks.push({ ...region, headingPath: section.headingPath, kind: 'PARENT', parent: null });
        for (const r of packUnits(childUnits(region.start, region.end, cps), config.childTarget, config.childMax, config.childOverlap)) {
          blocks.push({ ...r, headingPath: section.headingPath, kind: 'CHILD', parent: parentIndex });
        }
      }
    }
  }
  const results = finalize(blocks, cps);
  validateResults(results, cps, config);
  return results;
}

export const structureStrategy: ChunkStrategy = { name: 'structure', chunk: splitStructure };
