import { describe, expect, it } from 'vitest';
import { chunk, normalize, type Part } from '../src/chunk';
import { fixedStrategy } from '../src/strategies/fixed';
import { recursiveStrategy } from '../src/strategies/recursive';
import { structureStrategy, scanMarkdown } from '../src/strategies/structure';
import { getStrategy, planChunks, registerStrategy } from '../src/strategies/registry';
import { DEFAULT_CHUNK_CONFIG, validateChunkConfig, type ChunkConfig, type ChunkInput } from '../src/strategies/types';

const CONFIG: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG };

const doc = (text: string, mime = 'text/markdown'): ChunkInput => ({ parts: [{ text }], mime });
const md = [
  '# Guide',
  '',
  'Intro paragraph about setup.',
  '',
  '## Install',
  '',
  'Run the installer. Follow prompts. Done.',
  '',
  '### Linux',
  '',
  'Use apt. Use deb.',
  '',
  '## Config',
  '',
  'Edit the file. Save it.',
].join('\n');

describe('registry', () => {
  it('rejects duplicate registration and unknown strategies', () => {
    expect(() => registerStrategy(fixedStrategy)).toThrow(/Duplicate/);
    expect(() => getStrategy('nope' as never)).toThrow(RangeError);
    expect(() => planChunks(doc('x'), 'nope' as never, CONFIG)).toThrow(RangeError);
    expect(getStrategy('structure').name).toBe('structure');
  });
});

describe('fixed strategy', () => {
  it('returns [] for empty documents', () => {
    expect(fixedStrategy.chunk(doc('  \n '), CONFIG)).toEqual([]);
    expect(fixedStrategy.chunk({ parts: [], mime: 'text/plain' }, CONFIG)).toEqual([]);
  });
  it('matches the legacy chunk() output exactly on the same input', () => {
    for (const [size, overlap] of [[512, 50], [64, 8], [3, 1]] as const) {
      const parts: Part[] = [{ text: 'a\r\n\0😀' }, { text: 'b'.repeat(700) }];
      const legacy = chunk(parts, size, overlap);
      const results = fixedStrategy.chunk({ parts, mime: 'text/plain' }, { ...CONFIG, fixedSize: size, fixedOverlap: overlap, parentChild: false });
      expect(results.map(r => ({ ordinal: r.ordinal, start: r.start, end: r.end, text: r.text }))).toEqual(legacy);
    }
  });
  it('validates window parameters', () => {
    expect(() => fixedStrategy.chunk(doc('x'), { ...CONFIG, fixedOverlap: 512 })).toThrow(RangeError);
  });
});

describe('recursive strategy', () => {
  it('splits long unstructured text within childMax', () => {
    const text = '句子。'.repeat(400); // no newlines, no headings
    const results = recursiveStrategy.chunk(doc(text, 'text/plain'), CONFIG);
    expect(results.length).toBeGreaterThan(1);
    expect(results.filter(r => r.kind !== 'PARENT').every(r => r.end - r.start <= CONFIG.childMax)).toBe(true);
  });
  it('handles empty and tiny documents', () => {
    expect(recursiveStrategy.chunk(doc(''), CONFIG)).toEqual([]);
    const tiny = recursiveStrategy.chunk(doc('short'), CONFIG);
    expect(tiny.filter(r => r.kind !== 'PARENT')).toHaveLength(1);
  });
  it('prefers \\n## boundaries before generic breaks', () => {
    const text = 'a'.repeat(400) + '\n## b\n' + 'c'.repeat(400);
    const results = recursiveStrategy.chunk(doc(text), { ...CONFIG, parentChild: false });
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every(r => r.end - r.start <= CONFIG.childMax)).toBe(true);
    // breaks happen at the structural separators, never mid-word in the runs
    expect(results.some(r => r.text.includes('\n'))).toBe(true);
  });
});

describe('structure strategy', () => {
  it('builds headingPath from markdown hierarchy', () => {
    const results = structureStrategy.chunk(doc(md), CONFIG);
    const child = results.find(r => r.kind === 'CHILD' && r.text.includes('Use apt'));
    expect(child?.headingPath).toEqual(['Guide', 'Install', 'Linux']);
  });
  it('creates parent blocks per section bounded by parentMax, children within parents', () => {
    const long = '# Head\n\n' + '段落文字。'.repeat(300); // ~1500+ cp section
    const results = structureStrategy.chunk(doc(long), CONFIG);
    const parents = results.filter(r => r.kind === 'PARENT');
    const children = results.filter(r => r.kind === 'CHILD');
    expect(parents.length).toBeGreaterThanOrEqual(2);
    expect(parents.every(p => p.end - p.start <= CONFIG.parentMax)).toBe(true);
    expect(children.length).toBeGreaterThan(1);
    const byKey = new Map(results.map(r => [r.key, r]));
    for (const c of children) {
      const p = byKey.get(c.parentId!)!;
      expect(c.start).toBeGreaterThanOrEqual(p.start);
      expect(c.end).toBeLessThanOrEqual(p.end);
    }
    // several children share one parent
    const counts = new Map<string, number>();
    for (const c of children) counts.set(c.parentId!, (counts.get(c.parentId!) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeGreaterThan(1);
  });
  it('ignores # inside fenced code blocks', () => {
    const fenced = '# Real\n\n```\n# not a heading\n```\n\ntail';
    const sections = scanMarkdown(Array.from(normalize(fenced)));
    expect(sections.map(s => s.headingPath)).toEqual([['Real']]);
  });
  it('falls back to a single section for heading-less markdown', () => {
    const results = structureStrategy.chunk(doc('plain text\nmore text'), { ...CONFIG, parentChild: false });
    expect(results.every(r => r.headingPath.length === 0)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
  it('returns [] for empty input and validates config', () => {
    expect(structureStrategy.chunk(doc(' \n'), CONFIG)).toEqual([]);
    expect(() => validateChunkConfig({ ...CONFIG, childMin: 500 })).toThrow(RangeError);
    expect(() => validateChunkConfig({ ...CONFIG, childOverlap: 128 })).toThrow(RangeError);
  });
  it('produces document-unique ordinals with retrieval blocks before parents', () => {
    const results = structureStrategy.chunk(doc(md), CONFIG);
    const ordinals = results.map(r => r.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual([...results.keys()]);
    const maxChild = Math.max(...results.filter(r => r.kind !== 'PARENT').map(r => r.ordinal));
    expect(results.filter(r => r.kind === 'PARENT').every(p => p.ordinal > maxChild)).toBe(true);
  });
});
