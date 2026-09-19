/**
 * stats.ts 合成数据自测：已知答案验证（M6 出口：统计测试使用已知答案的合成数据通过）。
 */
import { describe, expect, it } from 'vitest';
import { bootstrapMeanDiffCI, mcnemarExact, mulberry32, weightedKappa, wilsonCI } from './stats';

describe('wilsonCI', () => {
  it('k=0/n=0 → 全区间', () => {
    expect(wilsonCI(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
  it('k=85/n=100 → 中心≈0.85，区间含 0.85 且宽度合理', () => {
    const { lo, hi } = wilsonCI(85, 100);
    expect(lo).toBeGreaterThan(0.76);
    expect(hi).toBeLessThan(0.91);
    expect(lo).toBeLessThan(0.85);
    expect(hi).toBeGreaterThan(0.85);
  });
  it('单调性：k 增大 lo 不减', () => {
    expect(wilsonCI(10, 40).lo).toBeLessThanOrEqual(wilsonCI(20, 40).lo);
  });
});

describe('mcnemarExact', () => {
  it('无不一致对 → p=1', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });
  it('高度不平衡 (3, 22) → 显著（p<0.01）', () => {
    // 已知：Bin(25,0.5) 下 2*P(X<=3) ≈ 0.0001565（精确二项）
    const p = mcnemarExact(3, 22);
    expect(p).toBeCloseTo(0.000156522, 6);
    expect(p).toBeLessThan(0.001);
  });
  it('完全平衡 (10, 10) → p=1', () => {
    expect(mcnemarExact(10, 10)).toBe(1);
  });
  it('对称性：swap b01/b10 不变', () => {
    expect(mcnemarExact(4, 12)).toBeCloseTo(mcnemarExact(12, 4), 12);
  });
});

describe('weightedKappa（二次权重，已知构造）', () => {
  it('完全一致 → 1', () => {
    expect(weightedKappa([0, 1, 2, 1, 0], [0, 1, 2, 1, 0], 3)).toBeCloseTo(1, 10);
  });
  it('独立评分 → ≈0（大样本对称构造）', () => {
    const rng = mulberry32(7);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 4000; i++) {
      a.push(Math.floor(rng() * 3));
      b.push(Math.floor(rng() * 3));
    }
    const k = weightedKappa(a, b, 3);
    expect(Math.abs(k)).toBeLessThan(0.06);
  });
  it('系统性偏移 1 档 → kappa 在 (0,1) 之间且中等', () => {
    const a = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0];
    const b = a.map((v) => Math.min(2, v + 1));
    const k = weightedKappa(a, b, 3);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(0.7);
  });
  it('长度不等 → NaN', () => {
    expect(Number.isNaN(weightedKappa([1, 2], [1], 3))).toBe(true);
  });
});

describe('bootstrapMeanDiffCI', () => {
  it('恒等样本 → 区间含 0，点估计 0', () => {
    const x = [1, 2, 3, 4, 5];
    const r = bootstrapMeanDiffCI(x, [...x], { rng: mulberry32(1) });
    expect(r.pointEstimate).toBe(0);
    expect(r.lo).toBeLessThanOrEqual(0);
    expect(r.hi).toBeGreaterThanOrEqual(0);
  });
  it('平移 +2 → 点估计 2，区间不含 0', () => {
    const x = [5, 6, 7, 8, 9, 10, 11, 12];
    const y = x.map((v) => v - 2);
    const r = bootstrapMeanDiffCI(x, y, { rng: mulberry32(1) });
    expect(r.pointEstimate).toBe(2);
    expect(r.lo).toBeGreaterThan(0);
  });
  it('同种子可复现', () => {
    const x = [3, 1, 4, 1, 5, 9, 2, 6];
    const y = [2, 0, 3, 0, 4, 8, 1, 5];
    const r1 = bootstrapMeanDiffCI(x, y, { rng: mulberry32(42) });
    const r2 = bootstrapMeanDiffCI(x, y, { rng: mulberry32(42) });
    expect(r1).toEqual(r2);
  });
});
