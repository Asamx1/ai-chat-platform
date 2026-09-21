import { beforeEach, expect, it, vi } from 'vitest';
const { getSession, queryRaw, executeRaw, transaction, getStrategy } = vi.hoisted(() => ({
  getSession: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  // Mirrors the real registry contract: only these names resolve, anything else throws.
  getStrategy: vi.fn((name: string) => {
    if (name !== 'fixed' && name !== 'recursive' && name !== 'structure') throw new RangeError(`Unknown chunk strategy: ${name}`);
  }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession } } }));
vi.mock('@aichat/db', () => ({ prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction } }));
vi.mock('@aichat/rag', () => ({ getStrategy }));
import { POST } from '../src/app/api/kb/[id]/rechunk/route';

const context = { params: Promise.resolve({ id: 'doc-1' }) };
const request = (body: unknown): Request =>
  new Request('http://localhost/api/kb/doc-1/rechunk', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'user-a' } });
  queryRaw.mockResolvedValue([{ id: 'doc-1' }]);
  executeRaw.mockResolvedValue(1);
  transaction.mockImplementation(async callback => callback({ $queryRaw: queryRaw, $executeRaw: executeRaw }));
});

it('requires authentication before touching the database', async () => {
  getSession.mockResolvedValue(null);
  const res = await POST(request({ strategy: 'fixed' }), context);
  expect(res.status).toBe(401);
  expect(transaction).not.toHaveBeenCalled();
});

it('rejects unknown strategies with 400 and clears no chunks', async () => {
  for (const strategy of ['semantics', '', null, 42, undefined]) {
    const res = await POST(request({ strategy }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'INVALID_REQUEST' });
  }
  expect(getStrategy).toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
});

it('rejects malformed bodies and out-of-range sizes with 400', async () => {
  for (const body of [null, 'fixed', [], { strategy: 'fixed', size: 0 }, { strategy: 'fixed', size: 8192 }, { strategy: 'fixed', size: 1.5 }]) {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
  }
  const bad = new Request('http://localhost', { method: 'POST', body: 'not json' });
  expect((await POST(bad, context)).status).toBe(400);
  expect(transaction).not.toHaveBeenCalled();
});

it('deletes old chunks and requeues the document through the existing queue', async () => {
  const res = await POST(request({ strategy: 'structure', size: 512 }), context);
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ id: 'doc-1', status: 'PENDING', chunkStrategy: 'structure' });
  expect(queryRaw.mock.calls[0]![0].join('')).toContain('FOR UPDATE OF d');
  expect(queryRaw.mock.calls[0]![1]).toEqual(['doc-1', 'user-a']);
  const sql = executeRaw.mock.calls.map(call => call[0].join(''));
  expect(sql[0]).toContain('DELETE FROM "Chunk"');
  expect(sql[1]).toContain(`status='PENDING'`);
  expect(sql[1]).toContain('"chunkStrategy"');
  expect(executeRaw.mock.calls[1]![1]).toEqual(['structure', 'doc-1']);
});

it('is idempotent: repeating the same request replays the same writes', async () => {
  const first = await POST(request({ strategy: 'recursive' }), context);
  const second = await POST(request({ strategy: 'recursive' }), context);
  expect([first.status, second.status]).toEqual([202, 202]);
  expect(executeRaw.mock.calls.length).toBe(4); // 2 deletes + 2 updates, identical payloads
  const firstPass = executeRaw.mock.calls.slice(0, 2).map(c => c[1]);
  const secondPass = executeRaw.mock.calls.slice(2, 4).map(c => c[1]);
  expect(firstPass).toEqual(secondPass);
});

it('returns 404 for documents the user does not own', async () => {
  queryRaw.mockResolvedValue([]);
  const res = await POST(request({ strategy: 'fixed' }), context);
  expect(res.status).toBe(404);
  expect(executeRaw).not.toHaveBeenCalled();
});
