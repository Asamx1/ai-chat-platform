/**
 * M7: 协作条件 executor 冒烟 —— CONSENSUS 三席（0.6b×2 + 7b）真模型跑一道题。
 * 独立套件（真模型重型）：pnpm exec vitest run experiments/runners/collab-smoke.test.ts
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config();

const { prisma, runCollab } = await import('./collab-executor');

describe('M7 collab executor smoke (real 3-seat CONSENSUS)', () => {
  it('runs a heterogeneous CONSENSUS question end-to-end via M4 pipeline', async () => {
    let alive = true;
    try {
      await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    } catch {
      alive = false;
    }
    if (!alive) return;

    const r = await runCollab(
      {
        mode: 'CONSENSUS',
        seats: [
          { seatId: 'a', modelKey: 'qwen3:0.6b', role: 'member', systemPrompt: '你是解题组成员。独立解题后给出最终答案。' },
          { seatId: 'b', modelKey: 'qwen3:0.6b', role: 'member', systemPrompt: '你是解题组成员。独立解题后给出最终答案。' },
          { seatId: 'sum', modelKey: 'qwen2.5:7b', role: 'summarizer', systemPrompt: '你是共识汇总人。综合各成员答案给出多数派答案，只输出最终答案。' },
        ],
      },
      '计算：17 × 23 = ?只回答数字。',
      'con-smoke',
    );
    console.log(`[m7-collab] degraded=${r.degraded} tokens=${r.completionTokens} text="${r.text.slice(0, 60)}"`);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.degraded).toBe(false);
    // 汇总人答案应含 391（三席里两个 0.6b 大概率对，7b 汇总采纳多数）
    expect(r.text).toContain('391');
  }, 300_000);

  afterAll(async () => {
    // 清实验用户及其数据（先删 runs 再删会话再删用户——外键顺序）
    await prisma.orchestrationRun.deleteMany({ where: { leaseOwner: { startsWith: 'm7-con-smoke' } } });
    await prisma.conversation.deleteMany({ where: { title: { startsWith: 'm7-con-smoke' } } });
    await prisma.user.deleteMany({ where: { email: 'm7-con-smoke@local' } });
    await prisma.$disconnect();
  });
});
