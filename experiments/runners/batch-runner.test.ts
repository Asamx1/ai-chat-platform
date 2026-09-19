import { describe, expect, it } from 'vitest';
import { runBatch, taskKey, CancelledError } from './batch-runner';
import type { ProgressStore, RunBatchOptions, Task, TaskOutcome } from './batch-runner';
import type { RunResult } from './result-schema';

/** Deterministic clock: steps forward by stepMs on every call. */
function makeSteppedClock(startMs: number, stepMs: number): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

function makeSource(tasks: Task[]): { next(): Promise<Task | null> } {
  let i = 0;
  return {
    async next() {
      return i < tasks.length ? tasks[i++] : null;
    },
  };
}

function makeStore(preloaded: RunResult[] = []): ProgressStore & { saved: RunResult[] } {
  const map = new Map<string, RunResult>();
  for (const r of preloaded) map.set(taskKey(r.manifestId, r), r);
  const saved: RunResult[] = [];
  return {
    saved,
    async load(key) {
      return map.get(key) ?? null;
    },
    async save(key, r) {
      map.set(key, r);
      saved.push(r);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}

function okOutcome(text: string): TaskOutcome {
  return {
    output: { text, usage: { promptTokens: 1, completionTokens: 1, costMicros: 0 } },
    metrics: { ttftMs: 5, totalMs: 10 },
  };
}

const baseTasks: Task[] = [
  { conditionId: 'c-single', repeat: 0, sampleId: 's0', input: 'q0' },
  { conditionId: 'c-single', repeat: 1, sampleId: 's1', input: 'q1' },
  { conditionId: 'c-consensus', repeat: 0, sampleId: 's0', input: 'q2' },
];

function opts(over: Partial<RunBatchOptions>): RunBatchOptions {
  return {
    manifestId: 'exp-1',
    source: makeSource(baseTasks),
    executor: { run: async (t) => okOutcome(`out:${t.input}`) },
    store: makeStore(),
    concurrency: 2,
    ...over,
  };
}

describe('runBatch', () => {
  it('runs 3 tasks at concurrency 2, all SUCCEEDED, with a complete event sequence', async () => {
    const events: string[] = [];
    const summary = await runBatch({
      ...opts({}),
      onEvent: (e) => events.push(e.type),
    });
    expect(summary).toMatchObject({ total: 3, succeeded: 3, failed: 0, skipped: 0, retries: 0 });
    expect(events).toContain('task-started');
    expect(events).toContain('task-succeeded');
    expect(events[events.length - 1]).toBe('batch-done');
    expect(events.filter((t) => t === 'task-started')).toHaveLength(3);
    expect(events.filter((t) => t === 'task-succeeded')).toHaveLength(3);
    // per-task ordering: started precedes succeeded for the same key
    const firstIdx = events.indexOf('task-started');
    expect(events.indexOf('task-succeeded')).toBeGreaterThan(firstIdx);
  });

  it('skips tasks already SUCCEEDED in the store (resume)', async () => {
    const done: RunResult = {
      manifestId: 'exp-1',
      conditionId: 'c-single',
      repeat: 0,
      sampleId: 's0',
      startedAt: '2026-09-19T00:00:00.000Z',
      finishedAt: '2026-09-19T00:00:01.000Z',
      status: 'SUCCEEDED',
    };
    const store = makeStore([done]);
    const events: string[] = [];
    const summary = await runBatch({ ...opts({ store }), onEvent: (e) => events.push(e.type) });
    expect(summary).toMatchObject({ total: 3, succeeded: 2, skipped: 1 });
    // the skipped task is never executed or re-saved
    expect(store.saved.filter((r) => r.conditionId === 'c-single' && r.sampleId === 's0' && r.repeat === 0)).toHaveLength(0);
    expect(events.filter((t) => t === 'task-started')).toHaveLength(2);
  });

  it('retries a task whose first attempt fails and second succeeds', async () => {
    const calls = new Map<string, number>();
    const executor = {
      async run(t: Task): Promise<TaskOutcome> {
        const k = taskKey('exp-1', t);
        const n = (calls.get(k) ?? 0) + 1;
        calls.set(k, n);
        if (n === 1) throw new Error('transient ollama error');
        return okOutcome('recovered');
      },
    };
    const retried: string[] = [];
    const summary = await runBatch({
      ...opts({ executor, concurrency: 1 }),
      onEvent: (e) => {
        if (e.type === 'task-retried') retried.push(e.key);
      },
    });
    expect(summary).toMatchObject({ total: 3, succeeded: 3, retries: 3 });
    expect(retried).toHaveLength(3);
  });

  it('stops pulling new tasks after abort; summary reflects CANCELLED in-flight work', async () => {
    const controller = new AbortController();
    const pulls: number[] = [];
    let nextCount = 0;
    const source = {
      async next(): Promise<Task | null> {
        nextCount += 1;
        pulls.push(nextCount);
        return nextCount <= baseTasks.length ? baseTasks[nextCount - 1] : null;
      },
    };
    // abort as soon as the first task starts
    const executor = {
      async run(t: Task): Promise<TaskOutcome> {
        controller.abort();
        return okOutcome(t.input);
      },
    };
    const summary = await runBatch({
      ...opts({ source, executor, concurrency: 1, signal: controller.signal }),
    });
    // concurrency 1: worker aborts after finishing the first in-flight task
    expect(summary.total).toBeLessThan(3);
    expect(summary.succeeded + summary.failed).toBe(summary.total);
    // in-flight task completed but marked CANCELLED
    expect(summary.failed).toBe(1);
    expect(pulls.length).toBeLessThan(4);
  });

  it('records CANCELLED when the executor throws CancelledError', async () => {
    const executor = {
      async run(): Promise<TaskOutcome> {
        throw new CancelledError('user abort');
      },
    };
    const store = makeStore();
    await runBatch({ ...opts({ executor, store, concurrency: 1, maxRetries: 2 }) });
    expect(store.saved.every((r) => r.status === 'CANCELLED')).toBe(true);
  });

  it('uses the injected clock for startedAt/finishedAt', async () => {
    const clock = makeSteppedClock(Date.UTC(2026, 8, 19, 0, 0, 0), 1000);
    const store = makeStore();
    await runBatch({ ...opts({ store, concurrency: 1, clock }) });
    expect(store.saved[0].startedAt).toBe('2026-09-19T00:00:00.000Z');
    expect(store.saved[0].finishedAt).toBe('2026-09-19T00:00:01.000Z');
    expect(store.saved[1].startedAt).toBe('2026-09-19T00:00:02.000Z');
  });
});
