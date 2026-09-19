/** M7: scoring + fs-store 单元测试。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCandidates, isCorrect, normalize, stripThinking } from '../analysis/scoring';
import { createFsStore } from './fs-store';

describe('scoring', () => {
  it('stripThinking 剥离思考段', () => {
    expect(stripThinking('<think>推理过程…</think>391')).toBe('391');
    expect(stripThinking('前置<think>a</think>中置<think>b</think>尾')).toBe('前置中置尾');
  });
  it('normalize 全半角/空白/大小写', () => {
    expect(normalize('Ｈ２Ｏ ｉｓ Water')).toBe('h2oiswater');
  });
  it('extractCandidates 含整串与数字', () => {
    const c = extractCandidates('答案是 391');
    expect(c).toContain('391');
  });
  it('isCorrect 命中路径', () => {
    expect(isCorrect('答案是391', '391')).toBe(true);
    expect(isCorrect('<think>算一下</think>17×23=391', '391')).toBe(true);
    expect(isCorrect('Ｈ２Ｏ', 'H2O')).toBe(true);
    expect(isCorrect('42', '391')).toBe(false);
    expect(isCorrect('我认为不能', '不能')).toBe(true);
  });
});

describe('createFsStore', () => {
  it('save→重开 store→load 命中（跨进程持久化语义）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm7store-'));
    try {
      const s1 = createFsStore('m7-t', { dir });
      s1.save('m7-t/c1/0/s0', {
        manifestId: 'm7-t', conditionId: 'c1', repeat: 0, sampleId: 's0',
        startedAt: '2026-09-24T00:00:00.000Z', finishedAt: '2026-09-24T00:00:01.000Z',
        status: 'SUCCEEDED',
      } as never);
      // 模拟新进程：重新打开同目录
      const s2 = createFsStore('m7-t', { dir });
      const loaded = await s2.load('m7-t/c1/0/s0');
      expect((loaded as unknown as { status: string } | null)?.status).toBe('SUCCEEDED');
      expect(await s2.load('m7-t/c1/0/s404')).toBeNull();
      // 文件内容是合法 jsonl
      const lines = readFileSync(s2.filePath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).sampleId).toBe('s0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
