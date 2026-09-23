import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { query, execute, storePlan, chunkDocument, planChunksAsync, writeUnlessAbortedImpl } = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), storePlan: vi.fn(), chunkDocument: vi.fn(), planChunksAsync: vi.fn(), writeUnlessAbortedImpl: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRawUnsafe: query, $executeRawUnsafe: execute } }));
vi.mock('@aichat/rag', async () => ({
  ...await import('../../../packages/rag/src/parse'), ...await import('../../../packages/rag/src/embed'),
  ...await import('../../../packages/rag/src/strategies/registry'),
  ...await import('../../../packages/rag/src/strategies/types'),
  chunkDocument,
  planChunksAsync,
  writeUnlessAborted: (signal: AbortSignal, run: () => Promise<unknown>) => { if (writeUnlessAbortedImpl.getMockImplementation()) return writeUnlessAbortedImpl(signal, run); signal.throwIfAborted(); return run(); },
  storePlan, LeaseLostError: class extends Error {},
}));
vi.mock('minio', () => ({
  Client: class {
    setRequestOptions(): void {}
    async getObject(_bucket: string, key: string) {
      return { async *[Symbol.asyncIterator]() { yield Buffer.from(key); }, destroy() {} };
    }
  },
}));
import { processDocument, runKbWorker } from '../src/kb-worker';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const job = (id: string) => ({ id, attempt: 1, mime: 'text/plain', objectKey: id, model: 'bge-m3:latest', size: id.length, chunkStrategy: 'fixed' });
const response = (input: string[]) => Response.json({ embeddings: input.map(() => Array(1024).fill(0.1)) });
beforeEach(() => {
  vi.clearAllMocks();
  chunkDocument.mockReset().mockImplementation(({ parts }: { parts: { text: string }[] }) => parts);
  planChunksAsync.mockReset().mockImplementation(async ({ parts }: { parts: unknown[] }) => parts as never);
  vi.stubEnv('KB_CONCURRENCY', '2');
  vi.stubEnv('EMBEDDING_MODEL', 'bge-m3:latest');
  vi.stubEnv('S3_ENDPOINT', 'http://localhost:9000');
  vi.stubEnv('S3_BUCKET', 'test');
  vi.stubEnv('MINIO_ROOT_USER', 'test');
  vi.stubEnv('MINIO_ROOT_PASSWORD', 'test');
  query.mockResolvedValue([]);
  execute.mockResolvedValue(1);
  storePlan.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(JSON.parse(init.body).input)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([
  [undefined, 2], ['', 2], ['1', 1], ['4', 4], ['8', 8], ['9', 8],
  ['0', 2], ['-1', 2], ['1.5', 2], ['invalid', 2], ['Infinity', 2], ['9007199254740992', 2],
])('parses KB_CONCURRENCY=%s and gives each loop a distinct owner', async (value, count) => {
  vi.stubEnv('KB_CONCURRENCY', value);
  await runKbWorker('worker', () => false, true);
  // Each loop now issues two SELECT claims (rebuild queue first, then documents).
  expect(query).toHaveBeenCalledTimes(count * 2);
  expect(new Set(query.mock.calls.map(call => call[1])).size).toBe(count);
});

it('claims concurrently without deadlock, drains without sleep and waits for every loop on shutdown', async () => {
  vi.useFakeTimers();
  const bothClaims = deferred();
  const releaseSlow = deferred();
  const slowStarted = deferred();
  const fastFinished = deferred();
  let claims = 0;
  let stopping = false;
  let settled = false;
  query.mockImplementation(async (sql: string, ..._rest: unknown[]) => {
    // Rebuild claims (CompileJob/RECHUNK) always come back empty here.
    if (sql.includes('RECHUNK')) return [];
    const index = claims++;
    if (claims === 2) bothClaims.resolve();
    await bothClaims.promise;
    return [job(['slow', 'fast', 'next'][index]!)];
  });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const { input } = JSON.parse(init.body);
    if (input[0] === 'slow') { slowStarted.resolve(); await releaseSlow.promise; }
    return response(input);
  }));
  storePlan.mockImplementation(async (id: string) => {
    if (id === 'next') { stopping = true; fastFinished.resolve(); }
  });
  const running = runKbWorker('worker', () => stopping).then(() => { settled = true; });
  try {
    await Promise.all([slowStarted.promise, fastFinished.promise]);
    expect(claims).toBe(3);
    expect(settled).toBe(false);
    expect(storePlan.mock.calls.map(call => call[0])).toEqual(['fast', 'next']);
  } finally {
    stopping = true;
    releaseSlow.resolve();
    await running;
  }
  expect(storePlan.mock.calls.map(call => call[0])).toEqual(['fast', 'next', 'slow']);
  const documentClaims = query.mock.calls.filter(call => !String(call[0]).includes('RECHUNK'));
  for (const call of storePlan.mock.calls) {
    expect(call[2]).toBe(documentClaims[call[0] === 'slow' ? 0 : call[0] === 'fast' ? 1 : 2]![1]);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('isolates document and failure-write errors and preserves model mismatch as permanent', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let documentClaims = 0;
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('RECHUNK')) return [];
    documentClaims += 1;
    return documentClaims === 1 ? [{ ...job('bad'), model: 'other-model' }] : [job('good')];
  });
  execute.mockImplementation(async (_sql, ...args) => {
    if (args[0] === 'bad') throw new Error('failure write unavailable');
    return 1;
  });
  await runKbWorker('worker', () => false, true);
  const failure = execute.mock.calls.find(call => call[1] === 'bad')!;
  expect(failure.slice(4)).toEqual(['FAILED', 'EMBEDDING_MODEL_MISMATCH']);
  expect(storePlan).toHaveBeenCalledTimes(1);
  expect(storePlan.mock.calls[0]![0]).toBe('good');
  expect(log).toHaveBeenCalledWith('[kb-worker]', expect.objectContaining({ message: 'failure write unavailable' }));
});

it('waits on an empty queue and exits without another claim after shutdown', async () => {
  vi.useFakeTimers();
  let stopping = false;
  const running = runKbWorker('worker', () => stopping);
  await vi.advanceTimersByTimeAsync(0);
  expect(query.mock.calls.filter(call => !String(call[0]).includes('RECHUNK'))).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(query.mock.calls.filter(call => !String(call[0]).includes('RECHUNK'))).toHaveLength(2);
  stopping = true;
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(query.mock.calls.filter(call => !String(call[0]).includes('RECHUNK'))).toHaveLength(2);
});

it('does not probe or claim when already stopping', async () => {
  await runKbWorker('worker', () => true);
  expect(fetch).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it('rejects unknown chunk strategies permanently before chunking', async () => {
  await processDocument({ ...job('bad'), chunkStrategy: 'unknown' }, 'worker');
  expect(chunkDocument).not.toHaveBeenCalled();
  expect(execute.mock.calls[0]!.slice(4)).toEqual(['FAILED', 'UNKNOWN_CHUNK_STRATEGY']);
  expect(storePlan).not.toHaveBeenCalled();
});

it.each([[1, 'PENDING'], [3, 'FAILED']])('preserves chunk failures and retry budget at attempt %s', async (attempt, status) => {
  planChunksAsync.mockImplementationOnce(() => { throw new Error('chunk internal failure'); });
  await processDocument({ ...job('bad'), attempt }, 'worker');
  expect(execute.mock.calls[0]!.slice(4)).toEqual([status, 'chunk internal failure']);
  expect(storePlan).not.toHaveBeenCalled();
});
