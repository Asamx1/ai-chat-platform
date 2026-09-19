/**
 * M6 实验统计工具：Wilson CI、McNemar 精确检验、加权 kappa、bootstrap 95% CI 均值差。
 * 纯 TS 无依赖；所有函数确定性（bootstrap 用注入 rng）。
 * 自测：experiments/analysis/stats.test.ts 用已知答案的合成数据验证。
 */

/** Wilson score interval for a binomial proportion (95% default). */
export function wilsonCI(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** McNemar exact test on paired binary outcomes. Returns two-sided exact p (binomial). */
export function mcnemarExact(b01: number, b10: number): number {
  // b01 = 条件A错B对, b10 = A对B错; n = discordant pairs
  const n = b01 + b10;
  if (n === 0) return 1;
  const k = Math.min(b01, b10);
  // two-sided exact: 2 * P(X <= k), X~Bin(n, 0.5), capped at 1
  let p = 0;
  for (let i = 0; i <= k; i++) p += binomPMF(i, n, 0.5);
  return Math.min(1, 2 * p);
}

function binomPMF(k: number, n: number, p: number): number {
  return binomCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

function binomCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** Quadratic weighted kappa for two raters, categories 0..K-1 (ordinal codes). */
export function weightedKappa(a: number[], b: number[], K: number): number {
  if (a.length !== b.length || a.length === 0) return NaN;
  // observed confusion matrix
  const O = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  for (let i = 0; i < a.length; i++) O[a[i]][b[i]] += 1;
  const n = a.length;
  const row = O.map((r) => r.reduce((s, v) => s + v, 0));
  const col = Array.from({ length: K }, (_, j) => O.reduce((s, r) => s + r[j], 0));
  const w = (i: number, j: number) => (i - j) * (i - j) / ((K - 1) * (K - 1)); // quadratic
  let num = 0;
  let den = 0;
  for (let i = 0; i < K; i++)
    for (let j = 0; j < K; j++) {
      num += w(i, j) * O[i][j];
      den += w(i, j) * row[i] * col[j] / n;
    }
  return den === 0 ? NaN : 1 - num / den;
}

/** Bootstrap 95% CI for mean difference (paired). rng: mulberry32(seed) style. */
export function bootstrapMeanDiffCI(
  x: number[],
  y: number[],
  opts: { B?: number; rng?: () => number } = {},
): { lo: number; hi: number; pointEstimate: number } {
  const B = opts.B ?? 2000;
  const rng = opts.rng ?? mulberry32(42);
  const d = x.map((v, i) => v - y[i]);
  const n = d.length;
  const point = d.reduce((s, v) => s + v, 0) / n;
  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rng() * n)];
    means.push(s / n);
  }
  means.sort((p, q) => p - q);
  return {
    lo: means[Math.floor(0.025 * B)],
    hi: means[Math.floor(0.975 * B) - 1],
    pointEstimate: point,
  };
}

/** 确定性 rng（统计可复现）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
