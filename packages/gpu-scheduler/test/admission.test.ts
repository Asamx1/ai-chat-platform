import { describe, expect, it } from 'vitest';
import { decide, estimateRequiredBytes } from '../src/index.js';

const GB = 1024 ** 3;

describe('admission decide', () => {
  it('passes through when the same model is already resident', () => {
    const d = decide(
      { modelName: 'qwen3:0.6b', estContextTokens: 1000 },
      { running: [{ name: 'qwen3:0.6b', sizeBytes: 1 * GB }] },
    );
    expect(d.admitted).toBe(true);
    expect(d.reason).toBe('already-loaded');
    expect(d.evictCandidate).toBeUndefined();
  });

  it('evicts the largest running model when 24G is full and a 4G model is requested', () => {
    const d = decide(
      { modelName: 'llama3:8b', estContextTokens: 0 },
      {
        running: [
          { name: 'qwen3:0.6b', sizeBytes: 1 * GB },
          { name: 'big:32b', sizeBytes: 20 * GB },
          { name: 'mid:7b', sizeBytes: 2 * GB },
        ],
      },
    );
    // 8b → 8*0.55+1 = 5.4GB; free = 1GB, evict big:32b → 21GB free → fits.
    expect(d.admitted).toBe(true);
    expect(d.reason).toBe('ok');
    expect(d.evictCandidate).toBe('big:32b');
  });

  it('rejects with would-oom when nothing is running but demand exceeds VRAM', () => {
    const d = decide(
      { modelName: 'huge:70b', estContextTokens: 100_000 },
      { running: [], totalVramBytes: 24 * GB },
    );
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('would-oom');
  });

  it('falls back to 8GB default for models estimateVram cannot parse', () => {
    expect(estimateRequiredBytes({ modelName: 'mystery', estContextTokens: 0 })).toBe(8 * GB);
    const d = decide(
      { modelName: 'mystery', estContextTokens: 0 },
      { running: [], totalVramBytes: 8 * GB },
    );
    expect(d.admitted).toBe(true);
    expect(d.reason).toBe('ok');
  });
});
