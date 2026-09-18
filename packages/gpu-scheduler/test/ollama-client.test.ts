import { describe, expect, it } from 'vitest';
import { estimateVram, getRunning, probe } from '../src/index.js';

describe('ollama-client (live local Ollama)', () => {
  it(
    'probe reports reachable with models loaded',
    async () => {
      const result = await probe();
      expect(result.reachable).toBe(true);
      expect(result.latencyMs).toBeLessThan(3000);
      expect(result.models.length).toBeGreaterThanOrEqual(1);
      expect(result.models.some((m) => m.name === 'qwen3:0.6b')).toBe(true);
    },
    10_000,
  );

  it('estimateVram parses parameter count from name', () => {
    expect(estimateVram('qwen3:0.6b')).toEqual({ paramsB: 0.6, estimatedGB: 1.33 });
  });

  it('estimateVram returns null for unknown naming patterns', () => {
    expect(estimateVram('unknown-model')).toBeNull();
  });

  it(
    'getRunning resolves to an array without throwing',
    async () => {
      const running = await getRunning();
      expect(Array.isArray(running)).toBe(true);
    },
    10_000,
  );
});
