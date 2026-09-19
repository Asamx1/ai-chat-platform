import type { RunResult } from './result-schema';

/**
 * M6-C2: Batch runner — a pure library (no CLI) driven by an orchestrator
 * (vitest in practice). Deterministic: all wall-clock time comes from an
 * injectable `clock`; task keys never contain timestamps.
 */

export interface Task {
  conditionId: string;
  repeat: number;
  sampleId: string;
  input: string;
}

/** Per-task body the executor returns; the runner fills identity + timing + status. */
export interface TaskOutcome {
  output?: RunResult['output'];
  metrics?: RunResult['metrics'];
  error?: string;
}

export interface TaskSource {
  next(): Promise<Task | null>;
}

export interface TaskExecutor {
  run(task: Task): Promise<TaskOutcome>;
}

export interface ProgressStore {
  load(key: string): Promise<RunResult | null>;
  save(key: string, r: RunResult): Promise<void>;
  keys(): Promise<string[]>;
}

/** Thrown by an executor to indicate the task was cancelled (e.g. via AbortSignal). */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export type BatchEvent =
  | { type: 'task-started'; key: string }
  | { type: 'task-succeeded'; key: string; result: RunResult }
  | { type: 'task-failed'; key: string; result: RunResult }
  | { type: 'task-retried'; key: string; attempt: number }
  | { type: 'batch-done'; summary: BatchSummary };

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  retries: number;
  elapsedMs: number;
}

export interface RunBatchOptions {
  /** Manifest identity used in task keys: `${manifestId}/${conditionId}/${repeat}/${sampleId}`. */
  manifestId: string;
  source: TaskSource;
  executor: TaskExecutor;
  store: ProgressStore;
  /** Worker-pool size, >= 1. */
  concurrency: number;
  /** Max retries per task after a FAILED attempt (default 1). */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Injectable clock for deterministic timestamps (default: real clock). */
  clock?: () => Date;
  onEvent?: (e: BatchEvent) => void;
}

export function taskKey(manifestId: string, t: Pick<Task, 'conditionId' | 'repeat' | 'sampleId'>): string {
  return `${manifestId}/${t.conditionId}/${t.repeat}/${t.sampleId}`;
}

export async function runBatch(opts: RunBatchOptions): Promise<BatchSummary> {
  const { manifestId, source, executor, store, signal, onEvent } = opts;
  const concurrency = Math.max(1, Math.trunc(opts.concurrency));
  const maxRetries = opts.maxRetries ?? 1;
  const clock = opts.clock ?? (() => new Date());

  // 顶层计时用真实时钟：注入 clock 仅供任务 startedAt/finishedAt（确定性时间戳），
  // 否则顶层一次调用会吃掉 stepped-clock 的第一步。
  const startedAtMs = Date.now();
  const summary: BatchSummary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    retries: 0,
    elapsedMs: 0,
  };

  async function runOnce(key: string, task: Task): Promise<RunResult> {
    const startedAt = clock();
    let outcome: TaskOutcome;
    let status: RunResult['status'];
    try {
      outcome = await executor.run(task);
      // Abort while in flight: the task finishes, but is recorded as CANCELLED.
      status = signal?.aborted ? 'CANCELLED' : 'SUCCEEDED';
    } catch (err) {
      if (err instanceof CancelledError) {
        outcome = { error: err.message };
        status = 'CANCELLED';
      } else {
        outcome = { error: err instanceof Error ? err.message : String(err) };
        status = 'FAILED';
      }
    }
    const result: RunResult = {
      manifestId,
      conditionId: task.conditionId,
      repeat: task.repeat,
      sampleId: task.sampleId,
      startedAt: startedAt.toISOString(),
      finishedAt: clock().toISOString(),
      status,
      ...outcome,
    };
    await store.save(key, result);
    return result;
  }

  async function handleTask(task: Task): Promise<void> {
    summary.total += 1;
    const key = taskKey(manifestId, task);

    // Resume: a previously SUCCEEDED run is skipped outright.
    const existing = await store.load(key);
    if (existing?.status === 'SUCCEEDED') {
      summary.skipped += 1;
      return;
    }

    onEvent?.({ type: 'task-started', key });
    let result = await runOnce(key, task);
    let attempt = 0;

    // Retry loop: only FAILED attempts are retried, never CANCELLED ones.
    while (result.status === 'FAILED' && attempt < maxRetries) {
      attempt += 1;
      summary.retries += 1;
      onEvent?.({ type: 'task-retried', key, attempt });
      result = await runOnce(key, task);
    }

    if (result.status === 'SUCCEEDED') {
      summary.succeeded += 1;
      onEvent?.({ type: 'task-succeeded', key, result });
    } else {
      summary.failed += 1;
      onEvent?.({ type: 'task-failed', key, result });
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return; // stop pulling new tasks once cancelled
      const task = await source.next();
      if (task === null) return;
      if (signal?.aborted) return; // re-check after the await: discard, don't count
      await handleTask(task);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  summary.elapsedMs = Date.now() - startedAtMs;
  onEvent?.({ type: 'batch-done', summary });
  return summary;
}
