import { beforeEach, expect, it, vi } from 'vitest';
const { query, execute } = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRawUnsafe: query, $executeRawUnsafe: execute } }));
vi.mock('@aichat/rag', async () => ({
  ...await import('../src/parse'), ...await import('../src/chunk'), ...await import('../src/embed'),
  store: vi.fn(), LeaseLostError: class extends Error {},
}));
import { claimDocument, failDocument, renewDocument } from '../../../apps/worker/src/kb-worker';
import { PermanentRagError } from '../src/parse';
const job = { id: 'doc', attempt: 2, mime: 'text/plain', objectKey: 'u/k/d', model: 'bge-m3:latest', size: 1 };
beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue([job]); execute.mockResolvedValue(1); });
it('claims atomically with SKIP LOCKED and recovers exhausted expired attempts', async () => {
  expect(await claimDocument('worker')).toEqual(job);
  expect(execute.mock.calls[0]![0]).toContain('attempt>=3');
  expect(execute.mock.calls[0]![0]).toContain('"leaseExpiresAt"<=clock_timestamp()');
  const [sql, worker] = query.mock.calls[0]!;
  expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  expect(sql).toContain('attempt<3');
  expect(sql).toContain("interval '30 seconds'");
  expect(worker).toBe('worker');
});
it('fences renewal using owner, attempt and unexpired lease', async () => {
  execute.mockResolvedValue(0);
  expect(await renewDocument(job, 'worker')).toBe(0);
  expect(execute.mock.calls[0]!.slice(1)).toEqual(['doc', 2, 'worker']);
  expect(execute.mock.calls[0]![0]).toContain('"leaseExpiresAt">clock_timestamp()');
});
it('requeues transient failure, fails third attempts and permanent errors', async () => {
  await failDocument(job, 'worker', new Error('network'));
  await failDocument({ ...job, attempt: 3 }, 'worker', new Error('network'));
  await failDocument(job, 'worker', new PermanentRagError('INVALID_UTF8'));
  expect(execute.mock.calls.map(call => call[4])).toEqual(['PENDING', 'FAILED', 'FAILED']);
  for (const call of execute.mock.calls) expect(call[0]).toContain('"leaseExpiresAt">clock_timestamp()');
});
