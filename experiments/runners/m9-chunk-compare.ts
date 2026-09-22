/**
 * M9-S9 分块策略对照实验：structure vs recursive vs fixed × 30 QA。
 * 纯向量臂（保持对照干净；hybrid 臂留作 S9b）：
 *   chunk（in-memory，走 @aichat/rag 注册表）→ Ollama bge-m3 嵌入（批量）→ 余弦 top-5 → qwen3:8b 判分。
 * 判分：format json + temperature 0；防御式解析，失败回退 hit=0。
 * 限速：全程串行 Ollama 调用；HTTP 错误重试 1 次，二次失败嵌入丢块、判分回退。
 * 运行：pnpm exec tsx experiments/runners/m9-chunk-compare.ts
 *   （3 策略 × 30 QA = 90 次判分 + 约 330 次嵌入；GPU 串行预计 15-30 分钟）
 * 输出：experiments/results/m9-chunk-compare.json（逐 QA 原始行 + 聚合）与 .md 摘要表。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { chunkDocument } from '../../packages/rag/src/chunk';
import { DEFAULT_CHUNK_CONFIG } from '../../packages/rag/src/strategies/types';
import type { ChunkResult, StrategyName } from '../../packages/rag/src/strategies/types';
import { wilsonCI } from '../analysis/stats';

config();

const OLLAMA = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'bge-m3:latest';
const JUDGE_MODEL = 'qwen3:8b';
const STRATEGIES: StrategyName[] = ['structure', 'recursive', 'fixed'];
const TOP_K = 5;

/** 语料：项目自身文档（QA 来源 3 篇 + 相邻文档凑足语料量）。 */
const CORPUS = [
  'docs/rag-arch.md',
  'docs/milestones/M8-report.md',
  'docs/api/m1-api-contract.md',
  'docs/api/m3-event-spec.md',
  'docs/milestones/M7-report.md',
  'docs/m9/01-prd.md',
];

type QA = { id: string; question: string; answer: string; doc: string };
type Row = {
  strategy: string;
  qaId: string;
  top5: Array<{ doc: string; ordinal: number; kind: string; sim: number }>;
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

/** 串行 + 重试 1 次；二次失败抛出（由调用方决定降级）。 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

/** Ollama /api/embed，输入一批文本，返回向量。 */
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

/** qwen3:8b 判分：问题 + 理想答案 + top-5 上下文 → {hit, score}。防御式解析，失败回退 hit=0。 */
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
    // 容忍代码块包裹 / 前后说明文字
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw) as { hit?: unknown; score?: unknown };
    const hit = parsed.hit === 1 || parsed.hit === '1' ? 1 : 0;
    const score = Number(parsed.score);
    return { hit, score: Number.isInteger(score) && score >= 1 && score <= 5 ? score : 1, fallback: false };
  } catch (e) {
    return { hit: 0, score: 1, fallback: true, error: String(e) };
  }
}

async function main(): Promise<void> {
  const dataset = JSON.parse(readFileSync('experiments/datasets/m9-qa.json', 'utf8')) as { items: QA[] };
  const qas = dataset.items;
  if (qas.length !== 30) throw new Error(`expected 30 QA, got ${qas.length}`);

  // 前置探针：Ollama 可用性
  await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5000) });

  const docs = CORPUS.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  const resultsDir = join(process.cwd(), 'experiments', 'results');
  mkdirSync(resultsDir, { recursive: true });

  const rows: Row[] = [];
  const perStrategy: Array<{ strategy: string; chunks: number; judgeFallbacks: number }> = [];

  for (const strategy of STRATEGIES) {
    // a. 分块（in-memory）；b. 嵌入（16/批，串行，重试 1 次，二次失败丢块）
    interface Indexed { doc: string; text: string; vec: number[]; ordinal: number; kind: string }
    const indexed: Indexed[] = [];
    let dropped = 0;
    for (const doc of docs) {
      // 与 retrieve.ts 一致：排除 PARENT，只索引 CHILD + STANDALONE
      const chunks: ChunkResult[] = chunkDocument(
        { parts: [{ text: doc.text }], mime: 'text/markdown' },
        strategy,
        DEFAULT_CHUNK_CONFIG,
      ).filter((c) => c.kind !== 'PARENT');
      for (let i = 0; i < chunks.length; i += 16) {
        const batch = chunks.slice(i, i + 16);
        try {
          const vecs = await withRetry(() => embedBatch(batch.map((c) => c.text)));
          batch.forEach((c, j) => indexed.push({ doc: doc.path, text: c.text, vec: vecs[j], ordinal: c.ordinal, kind: c.kind }));
        } catch {
          dropped += batch.length;
        }
      }
    }
    perStrategy.push({ strategy, chunks: indexed.length, judgeFallbacks: 0 });

    // c. 每 QA：嵌入问题 → 余弦 top-5；d. 判分
    for (const qa of qas) {
      const [qvec] = await embedBatch([qa.question]);
      const top5 = indexed
        .map((c) => ({ c, sim: cosine(qvec, c.vec) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, TOP_K);
      const verdict = await judge(qa, top5.map((t) => t.c.text));
      if (verdict.fallback) perStrategy[perStrategy.length - 1].judgeFallbacks++;
      rows.push({
        strategy,
        qaId: qa.id,
        top5: top5.map((t) => ({ doc: t.c.doc, ordinal: t.c.ordinal, kind: t.c.kind, sim: Number(t.sim.toFixed(4)) })),
        hit: verdict.hit,
        score: verdict.score,
        judgeFallback: verdict.fallback,
        error: verdict.error,
      });
      process.stderr.write(`[${strategy}] ${qa.id} hit=${verdict.hit} score=${verdict.score}\n`);
    }
  }

  // e. 聚合：hit@5 率、平均分、Wilson 95% 下界
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

  const payload = {
    experiment: 'm9-chunk-compare',
    ranAt: new Date().toISOString(),
    config: {
      strategies: STRATEGIES,
      embedModel: EMBED_MODEL,
      judgeModel: JUDGE_MODEL,
      arm: 'pure-vector (cosine top-5, no hybrid/rerank)',
      topK: TOP_K,
      corpus: CORPUS,
      judge: { temperature: 0, seed: 42, format: 'json' },
    },
    aggregates,
    rows,
  };
  writeFileSync(join(resultsDir, 'm9-chunk-compare.json'), JSON.stringify(payload, null, 2), 'utf8');

  // markdown 摘要表
  const md = [
    '# M9-S9 分块策略对照（纯向量臂）',
    '',
    `- 运行时间：${payload.ranAt}`,
    `- 嵌入：${EMBED_MODEL}（1024d）· 判分：${JUDGE_MODEL}（temp=0, json）· 语料：${CORPUS.length} 篇项目文档 · 30 QA`,
    '',
    '| 策略 | chunks | hit@5 | Wilson 95% 下界 | 平均分 (1-5) | 判分回退 |',
    '|---|---|---|---|---|---|',
    ...aggregates.map(
      (a) =>
        `| ${a.strategy} | ${a.chunks} | ${a.hits}/${a.n} (${(a.hitAt5 * 100).toFixed(1)}%) | ${a.wilsonLower95.toFixed(3)} | ${a.meanScore} | ${a.judgeFallbacks} |`,
    ),
    '',
    '> 纯向量余弦 top-5，无 RRF/MMR/重排（hybrid 臂为 S9b）。逐 QA 原始行见 m9-chunk-compare.json。',
    '',
  ].join('\n');
  writeFileSync(join(resultsDir, 'm9-chunk-compare.md'), md, 'utf8');

  process.stderr.write(`done: ${join(resultsDir, 'm9-chunk-compare.json')}\n`);
}

// 直接执行时运行（被 import 时不自动跑）
if (process.argv[1] && process.argv[1].endsWith('m9-chunk-compare.ts')) {
  main().catch((e) => {
    process.stderr.write(`${e}\n`);
    process.exit(1);
  });
}
