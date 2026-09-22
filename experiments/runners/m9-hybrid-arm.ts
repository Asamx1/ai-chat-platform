/**
 * M9-S9c hybrid 臂：与 m9-chunk-compare.ts（纯向量臂）同一 60-QA 数据集、同一判分协议，
 * 检索改为生产管线（packages/rag/src/retrieve.ts）的 in-memory 近似：
 *   BM25 词法（k1=1.5, b=0.75，CJK 字符 bigram + 拉丁按词切分，近似 pg tsv）
 *   → 与 bge-m3 余弦各自 top-20 → RRF k=60 融合 → MMR λ=0.5（top-20）→ 取 top-5 判分。
 * RRF/MMR 为 retrieve.ts 同语义的本地拷贝（原文件 import @aichat/db，无法独立引入）。
 * 纯向量基线：优先读 experiments/results/m9-chunk-compare.json，缺失时回退解析
 *   docs/experiments/m9-chunk-compare.md（仓库内提交的聚合表）。
 * 运行：pnpm exec tsx experiments/runners/m9-hybrid-arm.ts（或 node --experimental-strip-types）
 *   （3 策略 × 60 QA 判分，串行 Ollama，预计 15-30 分钟）
 * 输出：experiments/results/m9-hybrid-arm.{json,md}。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { wilsonCI } from '../analysis/stats';
import { chunkDocument } from '../../packages/rag/src/chunk';
import { DEFAULT_CHUNK_CONFIG } from '../../packages/rag/src/strategies/types';
import type { ChunkResult, StrategyName } from '../../packages/rag/src/strategies/types';

/** 轻量 .env 加载（等价现有 runner 的 dotenv config()，无依赖）。 */
loadDotEnv();

const OLLAMA = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3:latest';
const JUDGE_MODEL = 'qwen3:8b';
const STRATEGIES: StrategyName[] = ['structure', 'recursive', 'fixed'];
const TOP_K = 5;
const CANDIDATE_K = 20; // 每路 top-20，RRF 融合后截 top-20（与生产一致）
const RRF_K = 60;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** 与 m9-chunk-compare.ts 相同语料。 */
const CORPUS = [
  'docs/rag-arch.md',
  'docs/milestones/M8-report.md',
  'docs/api/m1-api-contract.md',
  'docs/api/m3-event-spec.md',
  'docs/milestones/M7-report.md',
  'docs/m9/01-prd.md',
];

type QA = { id: string; question: string; answer: string; doc: string };
interface Indexed {
  id: string; // doc#ordinal，RRF 去重键
  doc: string;
  text: string;
  vec: number[];
  ordinal: number;
  kind: string;
  tokens: Map<string, number>; // BM25 词频
}
type Row = {
  strategy: string;
  qaId: string;
  top5: Array<{ doc: string; ordinal: number; kind: string }>;
  hit: number;
  score: number;
  judgeFallback: boolean;
  error?: string;
};

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`${OLLAMA}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

/** 串行 + 重试 1 次；二次失败抛出（由调用方决定降级）。与现有 runner 一致。 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const d = (await postJson('/api/embed', { model: EMBED_MODEL, input: texts, truncate: false }, 60_000)) as {
    embeddings?: unknown;
  };
  if (!Array.isArray(d.embeddings) || d.embeddings.length !== texts.length) throw new Error('EMBED_COUNT');
  return d.embeddings as number[][];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 分词近似 pg tsv 'simple'：CJK 连续段滑窗字符 bigram（单字符段保留该字符），
 * 拉丁/数字连续段小写按词。查询与文档同用本函数，BM25 自洽。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const runs = lower.match(/[一-鿿]+|[a-z0-9]+/g) ?? [];
  for (const run of runs) {
    if (run[0]! >= '一' && run[0]! <= '鿿') {
      if (run.length === 1) tokens.push(run);
      else for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

export interface Bm25Index {
  df: Map<string, number>;
  docs: Indexed[];
  avgLen: number;
}

export function buildBm25(docs: Indexed[]): Bm25Index {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens.keys())) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((s, d) => s + termCount(d), 0) / (docs.length || 1);
  return { df, docs, avgLen };
}

function termCount(d: Indexed): number {
  let n = 0;
  for (const c of d.tokens.values()) n += c;
  return n;
}

/** BM25 得分（k1=1.5, b=0.75），返回按分排序的 (chunk, score)。 */
export function bm25Search(index: Bm25Index, query: string): Array<{ item: Indexed; score: number }> {
  const q = new Set(tokenize(query));
  const N = index.docs.length;
  return index.docs
    .map((item) => {
      const len = termCount(item);
      let score = 0;
      for (const t of q) {
        const tf = item.tokens.get(t);
        if (!tf) continue;
        const idf = Math.log(1 + (N - (index.df.get(t) ?? 0) + 0.5) / ((index.df.get(t) ?? 0) + 0.5));
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / index.avgLen)));
      }
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** retrieve.ts reciprocalRankFusion 同语义拷贝（k=60，一票/表，平分按输入序）。 */
export function reciprocalRankFusion(lists: readonly (readonly Indexed[])[]): Indexed[] {
  const fused = new Map<string, { item: Indexed; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rank += 1;
      const entry = fused.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (RRF_K + rank);
      fused.set(item.id, entry);
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map((e) => e.item);
}

/** retrieve.ts maximalMarginalRelevance 同语义拷贝（λ=0.5，秩归一相关性 − 最大余弦冗余）。 */
export function maximalMarginalRelevance(items: readonly Indexed[], limit: number): Indexed[] {
  const norm = items.map((it) => {
    const n = Math.sqrt(it.vec.reduce((s, v) => s + v * v, 0));
    return it.vec.map((v) => v / n);
  });
  const remaining = items.map((item, index) => ({ item, index, vector: norm[index]! }));
  const selected: typeof remaining = [];
  while (remaining.length && selected.length < limit) {
    let best = 0;
    let bestScore = -Infinity;
    for (const [index, cand] of remaining.entries()) {
      const relevance = items.length === 1 ? 1 : 1 - cand.index / (items.length - 1);
      let redundancy = 0;
      for (const prior of selected) {
        let dot = 0;
        for (let ax = 0; ax < cand.vector.length; ax++) dot += cand.vector[ax]! * prior.vector[ax]!;
        redundancy = Math.max(redundancy, Math.min(1, dot));
      }
      const score = 0.5 * relevance - 0.5 * redundancy;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    const [next] = remaining.splice(best, 1);
    if (next) selected.push(next);
  }
  return selected.map((c) => c.item);
}

/** qwen3:8b 判分：与 m9-chunk-compare.ts 完全相同的提示词/解析/回退。 */
async function judge(qa: QA, contexts: string[]): Promise<{ hit: number; score: number; fallback: boolean; error?: string }> {
  const prompt = [
    '你是检索质量评判员。根据检索到的上下文判断能否回答问题。',
    `问题：${qa.question}`,
    `理想答案：${qa.answer}`,
    '检索上下文（按相关性排序）：',
    ...contexts.map((c, i) => `【${i + 1}】${c.slice(0, 600)}`),
    '判断上下文是否包含支持得出理想答案的信息，并给检索质量打 1-5 分（5=首位即含答案，1=完全无关）。',
    '只输出 JSON：{"hit": 0 或 1, "score": 1-5 的整数}',
  ].join('\n');
  try {
    const d = (await withRetry(() =>
      postJson('/api/chat', {
        model: JUDGE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0, seed: 42 },
      }, 120_000),
    )) as { message?: { content?: string } };
    const raw = d.message?.content ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw) as { hit?: unknown; score?: unknown };
    const hit = parsed.hit === 1 || parsed.hit === '1' ? 1 : 0;
    const score = Number(parsed.score);
    return { hit, score: Number.isInteger(score) && score >= 1 && score <= 5 ? score : 1, fallback: false };
  } catch (e) {
    return { hit: 0, score: 1, fallback: true, error: String(e) };
  }
}

/** 纯向量基线：优先 results JSON，缺失时解析 docs 下聚合 md 表。 */
function loadPureVectorBaseline(): Array<{ strategy: string; hitAt5: number; hits: number; n: number; wilsonLower95: number }> {
  const jsonPath = join(process.cwd(), 'experiments', 'results', 'm9-chunk-compare.json');
  if (existsSync(jsonPath)) {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      aggregates?: Array<{ strategy: string; hitAt5: number; hits: number; n: number; wilsonLower95: number }>;
    };
    if (data.aggregates?.length) return data.aggregates;
  }
  const mdPath = join(process.cwd(), 'docs', 'experiments', 'm9-chunk-compare.md');
  const md = readFileSync(mdPath, 'utf8');
  const rows = [...md.matchAll(/\| (structure|recursive|fixed) \| \d+ \| (\d+)\/(\d+) \(([\d.]+)%\) \| ([\d.]+) \|/g)].map((m) => ({
    strategy: m[1]!,
    hits: Number(m[2]),
    n: Number(m[3]),
    hitAt5: Number(m[4]) / 100,
    wilsonLower95: Number(m[5]),
  }));
  if (rows.length < 3) throw new Error('cannot locate pure-vector baseline (m9-chunk-compare.json / .md)');
  return rows;
}

async function main(): Promise<void> {
  const dataset = JSON.parse(readFileSync('experiments/datasets/m9-qa.json', 'utf8')) as { items: QA[] };
  const qas = dataset.items;
  if (qas.length === 0) throw new Error('dataset has no QA items');

  await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });

  const docs = CORPUS.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const resultsDir = join(process.cwd(), 'experiments', 'results');
  mkdirSync(resultsDir, { recursive: true });

  const rows: Row[] = [];
  const perStrategy: Array<{ strategy: string; chunks: number; judgeFallbacks: number }> = [];

  for (const strategy of STRATEGIES) {
    const indexed: Indexed[] = [];
    let dropped = 0;
    for (const doc of docs) {
      const chunks: ChunkResult[] = chunkDocument(
        { parts: [{ text: doc.text }], mime: 'text/markdown' },
        strategy,
        DEFAULT_CHUNK_CONFIG,
      ).filter((c) => c.kind !== 'PARENT');
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        try {
          const vecs = await withRetry(() => embedBatch(batch.map((c) => c.text)));
          batch.forEach((c, j) =>
            indexed.push({
              id: `${doc.path}#${c.ordinal}`,
              doc: doc.path,
              text: c.text,
              vec: vecs[j]!,
              ordinal: c.ordinal,
              kind: c.kind,
              tokens: termFreq(tokenize(c.text)),
            }),
          );
        } catch {
          dropped += batch.length;
        }
      }
    }
    if (dropped > 0) process.stderr.write(`[${strategy}] dropped ${dropped} chunks (embed failure)\n`);
    const bm25 = buildBm25(indexed);
    perStrategy.push({ strategy, chunks: indexed.length, judgeFallbacks: 0 });

    for (const qa of qas) {
      const [qvec] = await embedBatch([qa.question]);
      // a+b. 两路各 top-20
      const vectorTop = indexed
        .map((c) => ({ c, sim: cosine(qvec!, c.vec) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, CANDIDATE_K)
        .map((t) => t.c);
      const lexicalTop = bm25Search(bm25, qa.question).slice(0, CANDIDATE_K).map((t) => t.item);
      // c. RRF k=60 融合 → top-20；d. MMR λ=0.5 → top-20
      let ranked = reciprocalRankFusion([vectorTop, lexicalTop]).slice(0, CANDIDATE_K);
      ranked = maximalMarginalRelevance(ranked, CANDIDATE_K);
      const top5 = ranked.slice(0, TOP_K);
      const verdict = await judge(qa, top5.map((c) => c.text));
      if (verdict.fallback) perStrategy[perStrategy.length - 1].judgeFallbacks++;
      rows.push({
        strategy,
        qaId: qa.id,
        top5: top5.map((c) => ({ doc: c.doc, ordinal: c.ordinal, kind: c.kind })),
        hit: verdict.hit,
        score: verdict.score,
        judgeFallback: verdict.fallback,
        error: verdict.error,
      });
      process.stderr.write(`[${strategy}] ${qa.id} hit=${verdict.hit} score=${verdict.score}\n`);
    }
  }

  const aggregates = STRATEGIES.map((strategy) => {
    const sRows = rows.filter((r) => r.strategy === strategy);
    const hits = sRows.filter((r) => r.hit === 1).length;
    const meanScore = sRows.reduce((s, r) => s + r.score, 0) / sRows.length;
    const ci = wilsonCI(hits, sRows.length);
    return {
      strategy,
      n: sRows.length,
      hits,
      hitAt5: hits / sRows.length,
      hitAt5Wilson95: { lo: Number(ci.lo.toFixed(4)), hi: Number(ci.hi.toFixed(4)) },
      wilsonLower95: Number(ci.lo.toFixed(4)),
      meanScore: Number(meanScore.toFixed(3)),
      chunks: perStrategy.find((p) => p.strategy === strategy)?.chunks ?? 0,
      judgeFallbacks: perStrategy.find((p) => p.strategy === strategy)?.judgeFallbacks ?? 0,
    };
  });

  const baseline = loadPureVectorBaseline();
  const comparison = STRATEGIES.map((strategy) => {
    const hybrid = aggregates.find((a) => a.strategy === strategy)!;
    const pure = baseline.find((b) => b.strategy === strategy);
    const delta = pure ? hybrid.hitAt5 - pure.hitAt5 : null;
    return { strategy, pureVector: pure ?? null, hybrid, delta };
  });
  const lifted = comparison.filter((c) => (c.delta ?? 0) > 0).length;
  const bestGain = comparison.reduce((a, b) => ((b.delta ?? -1) > (a.delta ?? -1) ? b : a));

  const payload = {
    experiment: 'm9-hybrid-arm',
    ranAt: new Date().toISOString(),
    config: {
      strategies: STRATEGIES,
      embedModel: EMBED_MODEL,
      judgeModel: JUDGE_MODEL,
      arm: 'hybrid (BM25 tsv-approx + bge-m3 cosine -> RRF k=60 -> MMR lambda=0.5 -> top-5; no LLM rerank, no small-to-big)',
      topK: TOP_K,
      candidateK: CANDIDATE_K,
      bm25: { k1: BM25_K1, b: BM25_B, tokenizer: 'CJK char-bigram + latin word (approximation of pg tsv simple)' },
      corpus: CORPUS,
      judge: { temperature: 0, seed: 42, format: 'json' },
      pureVectorBaselineSource: existsSync(join(resultsDir, 'm9-chunk-compare.json'))
        ? 'experiments/results/m9-chunk-compare.json'
        : 'docs/experiments/m9-chunk-compare.md',
    },
    aggregates,
    comparison,
    rows,
  };
  writeFileSync(join(resultsDir, 'm9-hybrid-arm.json'), JSON.stringify(payload, null, 2), 'utf8');

  const md = [
    '# M9-S9c 分块策略对照（hybrid 臂 vs 纯向量臂）',
    '',
    `- 运行时间：${payload.ranAt}`,
    `- 检索：BM25（k1=${BM25_K1}, b=${BM25_B}，CJK bigram+拉丁分词）+ ${EMBED_MODEL} 余弦 → RRF k=${RRF_K} → MMR λ=0.5 → top-5 · 判分：${JUDGE_MODEL}（temp=0, json）· ${qas.length} QA`,
    `- 纯向量基线来源：${payload.config.pureVectorBaselineSource}`,
    '',
    '| 策略 | chunks | 纯向量 hit@5 (Wilson 下界) | hybrid hit@5 (Wilson 下界) | Δ hit@5 | 平均分 | 判分回退 |',
    '|---|---|---|---|---|---|---|',
    ...comparison.map(
      (c) =>
        `| ${c.strategy} | ${c.hybrid.chunks} | ${c.pureVector ? `${c.pureVector.hits}/${c.pureVector.n} (${(c.pureVector.hitAt5 * 100).toFixed(1)}%) (${c.pureVector.wilsonLower95.toFixed(3)})` : 'n/a'} | ${c.hybrid.hits}/${c.hybrid.n} (${(c.hybrid.hitAt5 * 100).toFixed(1)}%) (${c.hybrid.wilsonLower95.toFixed(3)}) | ${c.delta === null ? 'n/a' : (c.delta >= 0 ? '+' : '') + (c.delta * 100).toFixed(1) + 'pp'} | ${c.hybrid.meanScore} | ${c.hybrid.judgeFallbacks} |`,
    ),
    '',
    `## 结论`,
    '',
    `hybrid 臂在 ${lifted}/${comparison.length} 个策略上提升 hit@5；受益最大的是 **${bestGain.strategy}**（Δ ${(bestGain.delta ?? 0) >= 0 ? '+' : ''}${((bestGain.delta ?? 0) * 100).toFixed(1)}pp）。` +
      `各策略 Wilson 95% 区间宽度约 ±8pp（n=60），小于 8pp 的提升应视为与噪声不可区分。` +
      `逐 QA 原始行与完整配置见 m9-hybrid-arm.json。`,
    '',
  ].join('\n');
  writeFileSync(join(resultsDir, 'm9-hybrid-arm.md'), md, 'utf8');

  process.stderr.write(`done: ${join(resultsDir, 'm9-hybrid-arm.json')}\n`);
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function loadDotEnv(): void {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // 无 .env 时忽略
  }
}

if (process.argv[1] && process.argv[1].endsWith('m9-hybrid-arm.ts')) {
  main().catch((e) => {
    process.stderr.write(`${e}\n`);
    process.exit(1);
  });
}
