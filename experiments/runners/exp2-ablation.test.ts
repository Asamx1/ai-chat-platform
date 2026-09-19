/**
 * M7 exp2 消融批跑：席位构成 / SELF_CONSISTENCY(7b×3 多数票) / DEBATE(1轮) × 48 题 × 3 repeats。
 * 复用 exp1 数据集与 baseline（c-single-7b / c-consensus 结果从 m7-exp1.jsonl 读回对照）。
 * 独立重型套件：pnpm exec vitest run experiments/runners/exp2-ablation.test.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config();

const OLLAMA = 'http://127.0.0.1:11434';

interface Row { id: string; q: string; ref: string; category: string }

async function single(model: string, q: string, temperature = 0.3): Promise<{ text: string; tokens: number }> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content: `${q}\n（直接给出最终答案，不要思考过程）` }],
      stream: false, think: false, options: { temperature, num_predict: 96 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${model} ${res.status}`);
  const d = (await res.json()) as { message: { content: string }; eval_count?: number };
  return { text: d.message.content ?? '', tokens: d.eval_count ?? 0 };
}

describe('M7 exp2: ablation (48q × 3r)', () => {
  it('runs seat-composition / self-consistency / debate ablation', async () => {
    const { validateManifest } = await import('../configs/schema');
    const manifest = validateManifest(JSON.parse(readFileSync('experiments/configs/m7-exp2.json', 'utf8')));
    const raw = readFileSync(`experiments/${manifest.dataset.path}`);
    expect(createHash('sha256').update(raw).digest('hex').slice(0, 16)).toBe(manifest.dataset.hash);
    let alive = true;
    try { await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }); } catch { alive = false; }
    if (!alive) return;

    const rows: Row[] = raw.toString().trim().split('\n').map((l) => JSON.parse(l));
    const { isCorrect } = await import('../analysis/scoring');
    const { wilsonCI, mcnemarExact, mulberry32 } = await import('../analysis/stats');
    const { createFsStore } = await import('./fs-store');
    const { runBatch } = await import('./batch-runner');
    const { runCollab } = await import('./collab-executor');

    const store = createFsStore(manifest.id, { dir: 'experiments/results' });
    type Out = { output: { text: string; usage: { promptTokens: number; completionTokens: number; costMicros: number } }; metrics: { ttftMs: number; totalMs: number } };

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
          const t = task as { conditionId: string; sampleId: string; input: string; repeat: number };
          const start = Date.now();
          if (t.conditionId === 'c-cons-strong') {
            // 强席共识：0.6b + 7b + 7b（汇总 7b）
            const r = await runCollab(
              {
                mode: 'CONSENSUS',
                seats: [
                  { seatId: 'a', modelKey: 'qwen3:0.6b', role: 'member', systemPrompt: '你是解题组成员。独立解题，给出最终答案（只输出答案本身）。' },
                  { seatId: 'b', modelKey: 'qwen2.5:7b', role: 'member', systemPrompt: '你是解题组成员。独立解题，给出最终答案（只输出答案本身）。' },
                  { seatId: 'sum', modelKey: 'qwen2.5:7b', role: 'summarizer', systemPrompt: '你是共识汇总人。综合各成员答案给出多数派最终答案，只输出答案本身。' },
                ],
              },
              t.input,
              `exp2s-${t.sampleId}-${t.repeat}`,
            );
            return { output: { text: r.text, usage: { promptTokens: 0, completionTokens: r.completionTokens, costMicros: 0 } }, metrics: { ttftMs: 0, totalMs: Date.now() - start } };
          }
          if (t.conditionId === 'c-selfcons') {
            // SELF_CONSISTENCY_K：7b ×3 采样（temp 0.7 引入多样性）+ 本地多数票
            const rng = mulberry32(43 * 7919 + t.repeat * 104729 + t.sampleId.length);
            const samples: string[] = [];
            let tokens = 0;
            for (let i = 0; i < 3; i++) {
              const r = await single('qwen2.5:7b', t.input, 0.7);
              samples.push(r.text);
              tokens += r.tokens;
            }
            // 多数票：候选抽取后计数（rng 未用于采样——Ollama 无 seed 透传，温度即多样性来源；rng 保留占位审计）
            void rng;
            const { extractCandidates } = await import('../analysis/scoring');
            const counts = new Map<string, number>();
            for (const s of samples) {
              const cands = extractCandidates(s).filter((c) => c.length <= 20);
              for (const c of new Set(cands)) counts.set(c, (counts.get(c) ?? 0) + 1);
            }
            let best = '';
            let bestN = -1;
            for (const [c, n] of counts) if (n > bestN || (n === bestN && c.length < best.length)) { best = c; bestN = n; }
            return { output: { text: best, usage: { promptTokens: 0, completionTokens: tokens, costMicros: 0 } }, metrics: { ttftMs: 0, totalMs: Date.now() - start } };
          }
          // c-debate：DEBATE 1 轮（pro=7b, con=0.6b, judge=7b）——裁判结论转答案
          const r = await runCollab(
            {
              mode: 'DEBATE', maxRounds: 1,
              seats: [
                { seatId: 'pro1', modelKey: 'qwen2.5:7b', role: 'pro', systemPrompt: '你是正方解题者：给出你认为正确的最终答案并简要论证（只输出答案+一句话理由）。' },
                { seatId: 'con1', modelKey: 'qwen3:0.6b', role: 'con', systemPrompt: '你是反方质疑者：如果你认为正方答案有误，给出你认为的正确答案（只输出答案+一句话理由）。' },
                { seatId: 'judge', modelKey: 'qwen2.5:7b', role: 'judge', systemPrompt: '你是裁判。评判双方给出的答案，输出你认为正确的最终答案（只输出答案本身）。' },
              ],
            },
            t.input,
            `exp2d-${t.sampleId}-${t.repeat}`,
          );
          return { output: { text: r.text, usage: { promptTokens: 0, completionTokens: r.completionTokens, costMicros: 0 } }, metrics: { ttftMs: 0, totalMs: Date.now() - start } };
        },
      },
      store,
      concurrency: 1,
    });
    console.log(`[exp2] batch: total=${summary.total} ok=${summary.succeeded} skip=${summary.skipped} fail=${summary.failed} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}min`);
    expect(summary.failed).toBe(0);

    // ===== 汇总（exp2 + exp1 baseline 读回）=====
    const refs = new Map(rows.map((r) => [r.id, r.ref]));
    const catOf = new Map(rows.map((r) => [r.id, r.category]));
    interface Res { conditionId: string; repeat: number; sampleId: string; status: string; output?: { text: string; usage: { completionTokens: number } }; metrics?: { totalMs: number } }
    const readJsonl = (p: string): Res[] => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const exp2 = readJsonl('experiments/results/m7-exp2.jsonl');
    const exp1 = readJsonl('experiments/results/m7-exp1.jsonl');

    const aggBy = (data: Res[], cond: string) => {
      const a = { k: 0, n: 0, tokens: 0, ms: 0 };
      const bySample = new Map<string, boolean>();
      for (const r of data) {
        if (r.conditionId !== cond || r.status !== 'SUCCEEDED') continue;
        a.n += 1;
        const ok = isCorrect(r.output?.text ?? '', refs.get(r.sampleId) ?? '');
        if (ok) a.k += 1;
        a.tokens += r.output?.usage.completionTokens ?? 0;
        a.ms += r.metrics?.totalMs ?? 0;
        bySample.set(`${r.sampleId}#${r.repeat}`, ok);
      }
      return { a, bySample };
    };
    const table: Array<Record<string, string | number>> = [];
    const corrMaps = new Map<string, Map<string, boolean>>();
    const conds: Array<[string, string, Res[]]> = [
      ['c-single-06b', 'SINGLE-0.6b (exp1)', exp1],
      ['c-single-7b', 'SINGLE-7b (exp1)', exp1],
      ['c-consensus', 'CONSENSUS 2weak+1strong (exp1)', exp1],
      ['c-cons-strong', 'CONSENSUS 1weak+2strong (exp2)', exp2],
      ['c-selfcons', 'SELF-CONSISTENCY 7b×3 (exp2)', exp2],
      ['c-debate', 'DEBATE 1R pro7b/con0.6b/j7b (exp2)', exp2],
    ];
    for (const [cond, label, src] of conds) {
      const { a, bySample } = aggBy(src, cond);
      if (a.n === 0) continue;
      const ci = wilsonCI(a.k, a.n);
      table.push({ condition: label, acc: +(a.k / a.n).toFixed(3), ci95: `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`, n: a.n, tokensPerQ: Math.round(a.tokens / a.n), msPerQ: Math.round(a.ms / a.n) });
      corrMaps.set(cond, bySample);
    }
    console.log('[exp2] TABLE-2 (all conditions):');
    console.table(table);

    // McNemar 矩阵（repeat0 配对，exp2 条件 vs SINGLE-7b）
    const s7 = corrMaps.get('c-single-7b') ?? new Map<string, boolean>();
    for (const cond of ['c-cons-strong', 'c-selfcons', 'c-debate']) {
      const m = corrMaps.get(cond) ?? new Map<string, boolean>();
      let b01 = 0, b10 = 0;
      for (const row of rows) {
        const c = m.get(`${row.id}#0`) ?? false;
        const s = s7.get(`${row.id}#0`) ?? false;
        if (c && !s) b01 += 1;
        if (!c && s) b10 += 1;
      }
      console.log(`[exp2] McNemar ${cond} vs c-single-7b (r0): b01=${b01} b10=${b10} p=${mcnemarExact(b01, b10).toFixed(4)}`);
    }

    // trap 类专项（DEBATE 假设：对抗或减弱直觉陷阱）
    for (const cond of ['c-single-7b', 'c-debate', 'c-selfcons']) {
      const m = corrMaps.get(cond) ?? new Map<string, boolean>();
      let k = 0, n = 0;
      for (const row of rows) if (row.category === 'trap') { n += 1; if (m.get(`${row.id}#0`)) k += 1; }
      console.log(`[exp2] trap-acc ${cond} (r0): ${k}/${n}`);
    }

    expect(summary.succeeded + summary.skipped).toBe(tasks.length);
  }, 3_600_000);

  afterAll(async () => {
    const { prisma } = await import('./collab-executor');
    for (const p of ['m7-exp2s-', 'm7-exp2d-']) {
      await prisma.orchestrationRun.deleteMany({ where: { leaseOwner: { startsWith: p } } }).catch(() => {});
      await prisma.conversation.deleteMany({ where: { title: { startsWith: p } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { email: { startsWith: `m7-${p.slice(3)}` } } }).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });
});
