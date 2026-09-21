import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), events: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: { api: {
  getSession: async () => ({ user: { id: 'user' } }),
} } }));
vi.mock('@aichat/db', () => ({ prisma: {
  orchestrationRun: { findUnique: mocks.run },
  runEvent: { findMany: mocks.events },
} }));
import { GET } from '../src/app/api/runs/[runId]/events/route';

const event = (seq: number, type: string) => ({
  seq, type, createdAt: new Date(0), payload: type === 'provider.delta' ? { delta: '你好' } : {},
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.run.mockResolvedValue({ ownerId: 'user', status: 'RUNNING' });
});

it.each([false, true])('delivers failed → delta → succeeded across batches=%s', async separateBatches => {
  const failed = event(2, 'run.failed');
  const recovery = [event(3, 'provider.delta'), event(4, 'run.succeeded')];
  if (separateBatches) {
    mocks.events.mockResolvedValueOnce([failed]).mockResolvedValueOnce(recovery);
  } else {
    mocks.events.mockResolvedValueOnce([failed, ...recovery]);
  }
  const response = await GET(new Request('http://localhost/api/runs/run/events'), {
    params: Promise.resolve({ runId: 'run' }),
  });
  const frames = (await response.text()).split('\n').filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5)));
  expect(frames.map(frame => frame.type)).toEqual(['run.failed', 'provider.delta', 'run.succeeded']);
  expect(frames[1].payload.delta).toBe('你好');
});

it('confirms an exhausted terminal failure so the client can close without reconnecting', async () => {
  mocks.run.mockResolvedValue({ ownerId: 'user', status: 'FAILED' });
  mocks.events.mockResolvedValueOnce([event(2, 'run.failed')]).mockResolvedValue([]);
  const response = await GET(new Request('http://localhost/api/runs/run/events'), {
    params: Promise.resolve({ runId: 'run' }),
  });
  const body = await response.text();
  expect(body).toContain('"run.failed"');
  expect(body).toContain('"stream.end"');
  expect(mocks.events).toHaveBeenCalledTimes(2);
});
