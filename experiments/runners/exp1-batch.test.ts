/**
 * M7 exp1 正式对照批跑：SINGLE(0.6b) vs SINGLE(7b) vs CONSENSUS(0.6b×2+7b) × 48 题 × 3 repeats。
 * 全链路：manifest 校验 → fs-store 断点续跑 → executor（单席直连 / 三席 M4 管线）→ 判分 → McNemar+Wilson 汇总。
 * 独立重型套件：pnpm exec vitest run experiments/runners/exp1-batch.test.ts
 * （CONSENSUS 每题 ~5s + SINGLE 每题 ~1s；48×3×(1+1+1) ≈ 全程 15-25 分钟，GPU 串行）
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config();

const OLLAMA = 'http://127.0.0.1:11434';

interface Row { id: string; q: string; ref: string; category: string; difficulty: number }

async function single(model: string, q: string): Promise<{ text: string; tokens: number }> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content: `${q}\n（直接给出最终答案，不要思考过程）` }],
      stream: false, think: false, options: { temperature: 0.3, num_predict: 96 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${model} ${res.status}`);
  const d = (await res.json()) as { message: { content: string }; eval_count?: number };
  return { text: d.message.content ?? '', tokens: d.eval_count ?? 0 };
}

describe('M7 exp1: SINGLE vs CONSENSUS (48q × 3r)', () => {
  it('runs the full budget-matched comparison and produces the first paper table', async () => {
    // 前置：manifest + hash + ollama
    const { validateManifest } = await import('../configs/schema');
    const manifest = validateManifest(JSON.parse(readFileSync('experiments/configs/m7-exp1.json', 'utf8')));
    const raw = readFileSync(`experiments/${manifest.dataset.path}`);
    expect(createHash('sha256').update(raw).digest('hex').slice(0, 16)).toBe(manifest.dataset.hash);
    let alive = true;
    try { await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }); } catch { alive = false; }
    if (!alive) return;

    const rows: Row[] = raw.toString().trim().split('\n').map((l) => JSON.parse(l));
    const { isCorrect } = await import('../analysis/scoring');
    const { wilsonCI, mcnemarExact } = await import('../analysis/stats');
    const { createFsStore } = await import('./fs-store');
    const { runBatch } = await import('./batch-runner');
    const { runCollab, prisma } = await import('./collab-executor');

    const store = createFsStore(manifest.id, { dir: 'experiments/results' });
    type Out = { output: { text: string; usage: { promptTokens: number; completionTokens: number; costMicros: number } }; metrics: { ttftMs: number; totalMs: number } };

    // 任务源：3 条件 × 48 题 × 3 repeats
    const REPEATS = manifest.repeats;
    const tasks: Array<{ conditionId: string; repeat: number; sampleId: string; input: string }> = [];
    for (let r = 0; r < REPEATS; r++)
      for (const cond of manifest.conditions)
        for (const row of rows)
          tasks.push({ conditionId: cond.id, repeat: r, sampleId: row.id, input: row.q });
    let ti = 0;
    const t0 = Date.now();

    const summary = await runBatch({
      manifestId: manifest.id,
      source: { next: async () => (ti < tasks.length ? tasks[ti++] : null) },
      executor: {
        run: async (task: unknown): Promise<Out> => {
          const t = task as { conditionId: string; sampleId: string; input: string };
          const start = Date.now();
          if (t.conditionId.startsWith('c-single')) {
            const model = t.conditionId === 'c-single-06b' ? 'qwen3:0.6b' : 'qwen2.5:7b';
            const r = await single(model, t.input);
            return { output: { text: r.text, usage: { promptTokens: 0, completionTokens: r.tokens, costMicros: 0 } }, metrics: { ttftMs: 0, totalMs: Date.now() - start } };
          }
          // CONSENSUS：三席 M4 管线（含 7b 汇总人）
          const r = await runCollab(
            {
              mode: 'CONSENSUS',
              seats: [
                { seatId: 'a', modelKey: 'qwen3:0.6b', role: 'member', systemPrompt: '你是解题组成员。独立解题，给出最终答案（只输出答案本身）。' },
                { seatId: 'b', modelKey: 'qwen3:0.6b', role: 'member', systemPrompt: '你是解题组成员。独立解题，给出最终答案（只输出答案本身）。' },
                { seatId: 'sum', modelKey: 'qwen2.5:7b', role: 'summarizer', systemPrompt: '你是共识汇总人。综合各成员答案给出多数派最终答案，只输出答案本身。' },
              ],
            },
            t.input,
            `exp1-${t.sampleId}-${t.conditionId}`,
          );
          return { output: { text: r.text, usage: { promptTokens: 0, completionTokens: r.completionTokens, costMicros: 0 } }, metrics: { ttftMs: 0, totalMs: Date.now() - start } };
        },
      },
      store,
      concurrency: 1, // GPU 串行
    });
    console.log(`[exp1] batch: total=${summary.total} ok=${summary.succeeded} skip=${summary.skipped} fail=${summary.failed} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}min`);
    expect(summary.failed).toBe(0);

    // 汇总：读回全部结果判分
    const all = await Promise.all(
      (await store.keys()).map(async (k) => ({ k, r: (await store.load(k)) as { conditionId: string; repeat: number; sampleId: string; status: string; output?: { text: string; usage: { completionTokens: number } }; metrics?: { totalMs: number } } })),
    );
    const refs = new Map(rows.map((r) => [r.id, r.ref]));
    const catOf = new Map(rows.map((r) => [r.id, r.category]));
    const byCond = new Map<string, { k: number; n: number; tokens: number; ms: number }>();
    const correctness = new Map<string, Map<string, boolean>>(); // cond -> sampleId -> any-repeat-correct (多数票)
    for (const { r } of all) {
      if (r.status !== 'SUCCEEDED') continue;
      const agg = byCond.get(r.conditionId) ?? { k: 0, n: 0, tokens: 0, ms: 0 };
      agg.n += 1;
      const ok = isCorrect(r.output?.text ?? '', refs.get(r.sampleId) ?? '');
      if (ok) agg.k += 1;
      agg.tokens += r.output?.usage.completionTokens ?? 0;
      agg.ms += r.metrics?.totalMs ?? 0;
      byCond.set(r.conditionId, agg);
      const m = correctness.get(r.conditionId) ?? new Map<string, boolean>();
      m.set(`${r.sampleId}#${r.repeat}`, ok);
      correctness.set(r.conditionId, m);
    }
    const table: Array<Record<string, string | number>> = [];
    for (const [cond, agg] of byCond) {
      const ci = wilsonCI(agg.k, agg.n);
      table.push({ condition: cond, acc: +(agg.k / agg.n).toFixed(3), ci95: `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`, n: agg.n, tokensPerQ: Math.round(agg.tokens / agg.n), msPerQ: Math.round(agg.ms / agg.n) });
    }
    console.log('[exp1] TABLE-1 (per-run accuracy):');
    console.table(table);

    // McNemar：CONSENSUS vs SINGLE-7b（repeat0 配对）
    const cons = correctness.get('c-consensus') ?? new Map();
    const s7 = correctness.get('c-single-7b') ?? new Map();
    let b01 = 0, b10 = 0; // cons对7b错 / cons错7b对
    for (const row of rows) {
      const c = cons.get(`${row.id}#0`) ?? false;
      const s = s7.get(`${row.id}#0`) ?? false;
      if (c && !s) b01 += 1;
      if (!c && s) b10 += 1;
    }
    const p = mcnemarExact(b01, b10);
    console.log(`[exp1] McNemar CONSENSUS vs SINGLE-7b (repeat0): b01=${b01} b10=${b10} p=${p.toFixed(4)}`);

    // 类别分解（CONSENSUS）
    const catAgg = new Map<string, { k: number; n: number }>();
    for (const [key, ok] of cons) {
      const id = key.split('#')[0];
      const cat = catOf.get(id) ?? '?';
      const a = catAgg.get(cat) ?? { k: 0, n: 0 };
      a.n += 1; if (ok) a.k += 1;
      catAgg.set(cat, a);
    }
    console.log('[exp1] CONSENSUS by category (repeat0):');
    for (const [cat, a] of catAgg) console.log(`  ${cat}: ${a.k}/${a.n}`);

    expect(summary.succeeded + summary.skipped).toBe(tasks.length);
  }, 3_600_000);

  afterAll(async () => {
    const { prisma } = await import('./collab-executor');
    await prisma.orchestrationRun.deleteMany({ where: { leaseOwner: { startsWith: 'm7-exp1' } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { title: { startsWith: 'm7-exp1' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: 'm7-exp1-' } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });
});
