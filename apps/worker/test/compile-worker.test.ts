import { afterEach, expect, it, vi } from 'vitest';
const { query, execute, transaction } = vi.hoisted(() => {
  const query = vi.fn(); const execute = vi.fn().mockResolvedValue(1);
  return { query, execute, transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRawUnsafe: query, $executeRawUnsafe: execute })) };
});
vi.mock('@aichat/db', () => ({ prisma: { $transaction: transaction, $queryRawUnsafe: query, $executeRawUnsafe: execute } }));
vi.mock('@aichat/rag/compile', () => ({ claimCompileJob: vi.fn(), consumeCompileOutbox: vi.fn(), compileSummary: vi.fn(),
  failCompileJob: vi.fn(), pauseForBudget: vi.fn(), renewCompileJob: vi.fn() }));
vi.mock('@aichat/rag', () => ({ embed: vi.fn(), embeddingModel: () => 'test' }));
import { reserveCompileBudget } from '../src/compile-worker';
import { claimDocument } from '../src/kb-worker';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const job = { id: 'job', kbId: 'kb', sourceVersionId: 'version', generationId: 'generation', artifactType: 'SUMMARY',
  attempt: 1, maxAttempts: 2, leaseOwner: 'owner', documentId: 'doc', userId: 'user' };

it('pauses at the budget without reserving a DeepSeek call', async () => {
  vi.stubEnv('RAG_COMPILE_BUDGET_CNY', '0');
  query.mockResolvedValueOnce([{ id: 'kb' }]).mockResolvedValueOnce([{ total: 0 }]);
  expect(await reserveCompileBudget(job)).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it('reserves cost atomically under the KB lock', async () => {
  query.mockResolvedValueOnce([{ id: 'kb' }]).mockResolvedValueOnce([{ total: 0 }]);
  expect(await reserveCompileBudget(job)).toBe(true);
  expect(query.mock.calls[0]![0]).toContain('FOR UPDATE');
  expect(execute.mock.calls[0]![0]).toContain('CompileCostLedger');
});

it('ordinary document claims exclude derived Wiki pages', async () => {
  query.mockResolvedValue([]);
  await claimDocument('owner');
  expect(execute.mock.calls[0]![0]).toContain("kind='SOURCE'");
  expect(query.mock.calls[0]![0]).toContain("kind='SOURCE'");
});
