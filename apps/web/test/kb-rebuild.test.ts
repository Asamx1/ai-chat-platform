import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  db: { $transaction: vi.fn(), $queryRaw: vi.fn(), $executeRawUnsafe: vi.fn(),
    indexGeneration: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    compileJob: { updateMany: vi.fn() }, compileOutbox: { updateMany: vi.fn() } },
}));
vi.mock('@aichat/db', () => ({ prisma: mocks.db }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
import { POST } from '../src/app/api/kb/[id]/rebuild/route';

const context = { params: Promise.resolve({ id: 'kb' }) };
const req = (body: unknown) => new Request('https://example.test/api/kb/kb/rebuild', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user' } });
  mocks.db.$transaction.mockImplementation((fn: (tx: typeof mocks.db) => unknown) => fn(mocks.db));
  mocks.db.$queryRaw.mockResolvedValue([{ id: 'kb', name: 'Owned' }]);
});

it('rejects anonymous rebuilds before touching the database', async () => {
  mocks.getSession.mockResolvedValue(null);
  expect((await POST(req({ mode: 'rebuild' }), context)).status).toBe(401);
  expect(mocks.db.$transaction).not.toHaveBeenCalled();
});

it('returns the existing BUILDING generation idempotently', async () => {
  mocks.db.indexGeneration.findFirst.mockResolvedValue({ id: 'existing', status: 'BUILDING' });
  const response = await POST(req({ mode: 'rebuild' }), context);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ jobId: 'existing', accepted: false });
  expect(mocks.db.indexGeneration.create).not.toHaveBeenCalled();
});

it('cancels the generation and every pending or running compile job', async () => {
  mocks.db.indexGeneration.findFirst.mockResolvedValue({ id: 'existing', status: 'BUILDING' });
  const response = await POST(req({ action: 'cancel' }), context);
  expect(await response.json()).toEqual({ jobId: 'existing', cancelled: true });
  expect(mocks.db.indexGeneration.update).toHaveBeenCalledWith({ where: { id: 'existing' }, data: { status: 'FAILED' } });
  expect(mocks.db.compileJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { generationId: 'existing', status: { in: ['PENDING', 'RUNNING'] } },
    data: expect.objectContaining({ status: 'CANCELLED' }),
  }));
});
