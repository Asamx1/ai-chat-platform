import { describe, expect, it, vi } from 'vitest';
import { planChunks, planChunksAsync, writeUnlessAborted } from '../src/strategies/registry';
import { DEFAULT_CHUNK_CONFIG, type ChunkConfig, type ChunkInput, type PlanContext, type PlanStats } from '../src/strategies/types';

const doc = (text: string): ChunkInput => ({ parts: [{ text }], mime: 'text/markdown' });
const config: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, childMin: 4, childTarget: 12, childMax: 40, childOverlap: 2, parentMax: 80 };
const context = (embedBatch: PlanContext['embedBatch'], onStats?: (stats: PlanStats) => void): PlanContext => ({ embedBatch, embeddingModel: 'fake-v1', onStats });
const clusters = async (texts: string[]): Promise<number[][]> => texts.map(text => text.includes('Beta') ? [0, 1] : [1, 0]);
const retrieval = (results: Awaited<ReturnType<typeof planChunksAsync>>) => results.filter(r => r.kind !== 'PARENT');

describe('semantic planning', () => {
  it('cuts between injected embedding clusters', async () => {
    const stats: PlanStats[] = [];
    const results = await planChunksAsync(doc('Alpha one. Alpha two. Beta one. Beta two.'), 'semantic', config, context(clusters, s => stats.push(s)));
    const children = retrieval(results);
    expect(children.some(c => c.text.includes('Alpha two.') && !c.text.includes('Beta one.'))).toBe(true);
    expect(children.some(c => c.text.includes('Beta one.'))).toBe(true);
    expect(stats[0]?.boundaries).toBeGreaterThan(0);
  });

  it('rejects nonfinite thresholds before calling embeddings', async () => {
    const embedBatch = vi.fn(clusters);
    for (const value of [NaN, Infinity, -Infinity]) {
      await expect(planChunksAsync(doc('Alpha. Beta.'), 'semantic', { ...config, semanticThreshold: value }, context(embedBatch))).rejects.toThrow(RangeError);
    }
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('uses structural rules for tables and fenced code without embedding their lines', async () => {
    const input = doc('# Guide\n| name | value |\n| --- | --- |\n| a | 1 |\n```ts\nconst x = 1;\nconst y = 2;\n```\n');
    const embedBatch = vi.fn(clusters);
    const results = await planChunksAsync(input, 'semantic', config, context(embedBatch));
    expect(embedBatch.mock.calls.flatMap(call => call[0]).every(text => !text.includes('const') && !text.includes('| a |'))).toBe(true);
    expect(retrieval(results).map(r => r.text).join('')).toContain('| a | 1 |');
    expect(retrieval(results).map(r => r.text).join('')).toContain('const y = 2;');
  });

  it('preserves confirmed boundaries while respecting child and parent limits', async () => {
    const text = 'Alpha one. Alpha two. Beta one. Beta two.';
    const results = await planChunksAsync(doc(text), 'semantic', config, context(clusters));
    expect(retrieval(results).every(r => r.end - r.start <= config.childMax)).toBe(true);
    expect(results.filter(r => r.kind === 'PARENT').every(r => r.end - r.start <= config.parentMax)).toBe(true);
    expect(retrieval(results).every(r => !(r.text.includes('Alpha two.') && r.text.includes('Beta one.')))).toBe(true);
  });

  it('keeps offsets, heading paths and parent references', async () => {
    const text = '# Guide\nAlpha one. Alpha two.\n## Next\nBeta one. Beta two.';
    const results = await planChunksAsync(doc(text), 'semantic', config, context(clusters));
    const byKey = new Map(results.map(r => [r.key, r]));
    for (const result of results) {
      expect(result.text).toBe(Array.from(text).slice(result.start, result.end).join(''));
      if (result.kind === 'CHILD') {
        const parent = byKey.get(result.parentId!);
        expect(parent?.kind).toBe('PARENT');
        expect(parent!.start).toBeLessThanOrEqual(result.start);
        expect(parent!.end).toBeGreaterThanOrEqual(result.end);
      }
    }
    expect(retrieval(results).find(r => r.text.includes('Beta one'))?.headingPath).toEqual(['Guide', 'Next']);
  });

  it('adapts fixed and structure without changing synchronous output', async () => {
    const input = doc('# Guide\nAlpha one. Beta two.');
    for (const strategy of ['fixed', 'structure'] as const) {
      const embedBatch = vi.fn(clusters);
      expect(await planChunksAsync(input, strategy, config, context(embedBatch))).toEqual(planChunks(input, strategy, config));
      expect(embedBatch).not.toHaveBeenCalled();
    }
  });

  it('falls back to structure and records the effective strategy on embedding failure', async () => {
    const input = doc('Alpha one. Beta two.');
    const stats: PlanStats[] = [];
    const result = await planChunksAsync(input, 'semantic', config, context(async () => { throw new Error('EMBED_UNAVAILABLE'); }, s => stats.push(s)));
    expect(result).toEqual(planChunks(input, 'structure', config));
    expect(stats[0]).toMatchObject({ requestedStrategy: 'semantic', effectiveStrategy: 'structure', degradeReason: 'EMBED_UNAVAILABLE' });
  });

  it('does not invoke the write callback after abort', async () => {
    const controller = new AbortController();
    const write = vi.fn(async () => undefined);
    controller.abort(new Error('LEASE_LOST'));
    await expect(writeUnlessAborted(controller.signal, write)).rejects.toThrow('LEASE_LOST');
    expect(write).not.toHaveBeenCalled();
  });
});
