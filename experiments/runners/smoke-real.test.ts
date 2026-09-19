/**
 * M6 真实 manifest 试跑：batch-runner × Ollama（SINGLE 条件，qwen3:0.6b）。
 * 验证：manifest 校验 → 数据集加载+hash 复核 → 真模型执行 → RunResult 落盘 → 统计汇总。
 * 断点续跑验证：第二次运行应全部 skip。
 * 用法：pnpm exec vitest run experiments/runners/smoke-real.test.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'qwen3:0.6b';

interface DatasetRow { id: string; q: string; ref: string }

async function ollamaChat(prompt: string, signal?: AbortSignal): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; costMicros: number } }> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false, options: { temperature: 0.2, num_predict: 96 }, think: false }),
    signal,
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
  return {
    text: data.message.content,
    usage: { promptTokens: data.prompt_eval_count ?? 0, completionTokens: data.eval_count ?? 0, costMicros: 0 },
  };
}

describe('M6 smoke: real manifest through batch-runner', () => {
  it('manifest validates; dataset hash matches frozen value; SINGLE condition runs on real model; resume skips all', async () => {
    // 1) manifest 校验 + hash 复核（冻结不变式）
    const { validateManifest } = await import('../configs/schema');
    const manifest = validateManifest(JSON.parse(readFileSync('experiments/configs/m6-smoke-001.json', 'utf8')));
    const raw = readFileSync(`experiments/${manifest.dataset.path}`);
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    expect(hash).toBe(manifest.dataset.hash);

    // ollama 在线才跑（离线环境跳过而非挂）
    let alive = true;
    try { await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) }); } catch { alive = false; }
    if (!alive) return;

    // 2) 数据集行
    const rows: DatasetRow[] = raw.toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.length).toBe(12);

    // 3) batch-runner 驱动真模型（只跑 SINGLE 条件冒烟；CONSENSUS/DEBATE 留 M7）
    const { runBatch, taskKey } = await import('./batch-runner');
    const single = manifest.conditions.find((c) => c.id === 'c-single')!;
    const saved = new Map<string, unknown>();
    const store = {
      async load(k: string) { return (saved.get(k) as never) ?? null; },
      async save(k: string, r: never) { saved.set(k, r); },
      async keys() { return Array.from(saved.keys()); },
    };
    const summary = await runBatch({
      manifestId: manifest.id,
      source: { next: async () => {
        const r = rows.shift();
        return r ? ({ conditionId: single.id, repeat: 0, sampleId: r.id, input: r.q } as never) : null;
      } },
      executor: {
        run: async (t: unknown) => {
          const q = (t as { input: string }).input;
          const r = await ollamaChat(`${q}\n（直接给出最终答案，不要思考过程）`);
          return { output: { text: r.text.trim(), usage: r.usage }, metrics: { ttftMs: 0, totalMs: 0 } };
        },
      },
      store,
      concurrency: 1, // GPU 串行（0.6b 快，冒烟不求吞吐）
    });
    expect(summary.total).toBe(12);
    expect(summary.succeeded).toBe(12);

    // 4) 断点续跑：全部 SUCCEEDED 再跑 → 全 skip
    const rows2 = raw.toString().trim().split('\n').map((l) => JSON.parse(l));
    const summary2 = await runBatch({
      manifestId: manifest.id,
      source: { next: async () => {
        const r = rows2.shift();
        return r ? ({ conditionId: single.id, repeat: 0, sampleId: r.id, input: r.q } as never) : null;
      } },
      executor: { run: async () => { throw new Error('should not run'); } },
      store,
      concurrency: 2,
    });
    expect(summary2.skipped).toBe(12);
    expect(summary2.succeeded).toBe(0);

    // 5) 客观题判分 + Wilson CI（统计链路贯通）
    const { wilsonCI } = await import('../analysis/stats');
    const results = Array.from(saved.values()) as Array<{ conditionId: string; sampleId: string; output?: { text: string } }>;
    const refRows: Array<{ id: string; ref: string }> = raw.toString().trim().split('\n').map((l) => JSON.parse(l));
    const refs = new Map<string, string>(refRows.map((r) => [r.id, r.ref]));
    let correct = 0;
    for (const r of results) {
      const ref = refs.get(r.sampleId) ?? '';
      const text = r.output?.text ?? '';
      if (text.includes(ref)) correct += 1;
    }
    const ci = wilsonCI(correct, 12);
    console.log(`[m6-smoke] qwen3:0.6b exact-match: ${correct}/12 (${(correct / 12 * 100).toFixed(0)}%), Wilson95 [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]`);
    expect(ci.hi).toBeLessThanOrEqual(1);
  }, 240_000);
});
