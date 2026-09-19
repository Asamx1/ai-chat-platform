/**
 * M7: 文件系统 ProgressStore —— results/ 目录 jsonl 落盘 + 恢复（断点续跑跨进程持久化）。
 * 格式：每行一个 RunResult JSON（与 result-schema 兼容），文件名 `<manifestId>.jsonl`。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressStore } from './batch-runner';

export interface FsStoreOptions {
  /** results 根目录（默认 experiments/results） */
  dir?: string;
  /** 写盘节流：N 条刷一次盘（默认 1=每条即刷；重写文件为原子语义：全量重写） */
  flushEvery?: number;
}

export function createFsStore(manifestId: string, opts: FsStoreOptions = {}): ProgressStore & { filePath: string } {
  const dir = opts.dir ?? join(process.cwd(), 'experiments', 'results');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${manifestId}.jsonl`);
  // 载入既有结果（断点续跑的持久化基础）
  const map = new Map<string, string>(); // key -> result json line
  const keys: string[] = [];
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { manifestId: string; conditionId: string; repeat: number; sampleId: string };
      const key = `${r.manifestId}/${r.conditionId}/${r.repeat}/${r.sampleId}`;
      map.set(key, line);
      keys.push(key);
    }
  }
  let dirty = 0;
  const flushEvery = opts.flushEvery ?? 1;
  const flush = (): void => {
    // 全量重写（结果文件小：百行级；避免 append 与去重的复杂度）
    writeFileSync(filePath, Array.from(map.values()).join('\n') + '\n', 'utf8');
    dirty = 0;
  };
  return {
    filePath,
    async load(key) {
      const line = map.get(key);
      return line ? (JSON.parse(line) as never) : null;
    },
    async save(key, r) {
      map.set(key, JSON.stringify(r));
      keys.push(key);
      dirty += 1;
      if (dirty >= flushEvery) flush();
    },
    async keys() {
      return [...keys];
    },
  };
}
