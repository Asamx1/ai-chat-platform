import { describe, expect, it } from 'vitest';
import { buildSeatContext, rollingSummary, type SeatConfig } from '../src/context-builder';
import { checkBudget, estimateTokens, degradeOrder, type Budget } from '../src/budget';

const seat: SeatConfig = {
  seatId: 'seat-1',
  modelId: 'qwen3:8b',
  role: 'analyst',
  systemPrompt: 'You are a careful analyst.',
};

const history = Array.from({ length: 30 }, (_, i): { role: 'user' | 'assistant'; content: string } => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `msg-${i}`,
}));

describe('buildSeatContext', () => {
  it('同输入产生相同 contextHash，异输入产生不同 hash', () => {
    const task = { role: 'user' as const, content: '本轮任务' };
    const a = buildSeatContext(seat, history, task);
    const b = buildSeatContext(seat, history, task);
    expect(a.contextHash).toBe(b.contextHash);
    expect(a.contextHash).toMatch(/^[0-9a-f]{16}$/);

    const c = buildSeatContext(seat, history, { role: 'user', content: '不同的任务' });
    expect(c.contextHash).not.toBe(a.contextHash);

    const otherSeat = { ...seat, systemPrompt: 'different prompt' };
    const d = buildSeatContext(otherSeat, history, task);
    expect(d.contextHash).not.toBe(a.contextHash);
  });

  it('结构为 [system, ...最近 N 条 history, task]，默认 N=20，可覆写', () => {
    const task = { role: 'user' as const, content: 'go' };
    const { messages } = buildSeatContext(seat, history, task);
    expect(messages).toHaveLength(22); // 1 system + 20 history + 1 task
    expect(messages[0]).toEqual({ role: 'system', content: seat.systemPrompt });
    expect(messages.at(-1)).toEqual(task);
    expect(messages[1]?.content).toBe('msg-10'); // 最近 20 条 = msg-10..msg-29

    const { messages: small } = buildSeatContext(seat, history, task, { maxHistoryMessages: 3 });
    expect(small).toHaveLength(5);
    expect(small[1]?.content).toBe('msg-27');
  });

  it('不修改入参 history', () => {
    const snapshot = JSON.stringify(history);
    buildSeatContext(seat, history, { role: 'user', content: 'x' });
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

describe('rollingSummary', () => {
  it('头部折叠为单条 system 消息，尾部 keepLast 条原样保留', () => {
    const out = rollingSummary(history, 5);
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ role: 'system', content: '[earlier context omitted: 25 messages]' });
    expect(out.slice(1)).toEqual(history.slice(-5));
  });

  it('消息数不超过 keepLast 时原样返回（新数组）', () => {
    const short = history.slice(0, 4);
    const out = rollingSummary(short, 5);
    expect(out).toEqual(short);
    expect(out).not.toBe(short);
  });
});

describe('checkBudget', () => {
  const budget: Budget = { runTokenLimit: 10000, perSeatReserve: 3000 };

  it('预算内放行', () => {
    expect(checkBudget(budget, { run: 5000, seat: 2000 }, 1000)).toEqual({ allowed: true });
  });

  it("run 累计 + 预估超 runTokenLimit 拒为 'run-limit'", () => {
    expect(checkBudget(budget, { run: 9500, seat: 2000 }, 1000)).toEqual({
      allowed: false,
      reason: 'run-limit',
    });
  });

  it("单席累计超 perSeatReserve 拒为 'seat-reserve'", () => {
    expect(checkBudget(budget, { run: 5000, seat: 3001 }, 1000)).toEqual({
      allowed: false,
      reason: 'seat-reserve',
    });
  });

  it('run-limit 优先于 seat-reserve 判定', () => {
    expect(checkBudget(budget, { run: 9999, seat: 4000 }, 100).reason).toBe('run-limit');
  });

  it('degradeOrder 为 trim-history → drop-seat → abort', () => {
    expect([...degradeOrder]).toEqual(['trim-history', 'drop-seat', 'abort']);
  });
});

describe('estimateTokens', () => {
  it('中文：~1.5 字/token 折中为 ceil(len/3)', () => {
    expect(estimateTokens('一二三四五六')).toBe(2); // 6 chars / 3
  });

  it('英文：向上取整', () => {
    expect(estimateTokens('abcd')).toBe(2); // 4 chars / 3 -> ceil = 2
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });
});
