import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prisma } from '@aichat/db';
import { FakeProvider } from '@aichat/providers';
import { sendChat, setChatProviderFactory } from '../../web/src/lib/chat-service';
import { claimNextRun } from '../src/lease';
import { processRun } from '../src/runner';

// Uses this suite's dedicated _test database guard and serial worker execution.
let userId: string;
beforeAll(async () => {
  const user = await prisma.user.create({ data: {
    email: `execution-race-${crypto.randomUUID()}@example.test`, passwordHash: 'x',
  } });
  userId = user.id;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (userId) {
    await prisma.orchestrationRun.deleteMany({ where: { ownerId: userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

function send() {
  return sendChat({ userId, content: 'hello', modelKey: 'fake-model',
    idempotencyKey: `test-execution-race-${crypto.randomUUID()}` });
}

async function expectSingleExecution(runId: string) {
  await vi.waitFor(async () => {
    expect(await prisma.runEvent.count({ where: { runId, type: 'run.succeeded' } })).toBe(1);
  });
  expect(await prisma.runEvent.count({ where: { runId, type: 'run.started' } })).toBe(1);
  expect(await prisma.runEvent.count({ where: { runId, type: 'run.failed' } })).toBe(0);
}

it('worker cannot claim inline after its lease check and before its first delta', async () => {
  vi.stubEnv('EXECUTION_MODE', 'inline');
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const provider = new FakeProvider(['hello']);
  const stream = vi.spyOn(provider, 'streamChat').mockImplementation(async function* () {
    await gate;
    yield { type: 'text-delta', delta: 'hello' };
    yield { type: 'done', finishReason: 'stop' };
  });
  setChatProviderFactory(() => provider);
  const { runId } = await send();
  try {
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    // This is the old TOCTOU window: inline has passed findUnique(leaseOwner).
    expect(await claimNextRun('race-worker')).toBeNull();
  } finally {
    resume();
    await expectSingleExecution(runId);
  }
  expect(stream).toHaveBeenCalledTimes(1);
});

it('worker mode queues only, then exactly one worker starts the run', async () => {
  vi.stubEnv('EXECUTION_MODE', 'worker');
  const provider = new FakeProvider(['hello']);
  const stream = vi.spyOn(provider, 'streamChat');
  setChatProviderFactory(() => provider);
  const { runId } = await send();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(stream).not.toHaveBeenCalled();
  expect(await prisma.runEvent.count({ where: { runId } })).toBe(0);
  const claimed = await claimNextRun('queue-worker');
  expect(claimed).toBe(runId);
  expect(await claimNextRun('second-worker')).toBeNull();
  await processRun(runId, 'queue-worker', { providerFactory: () => provider });
  await expectSingleExecution(runId);
  expect(stream).toHaveBeenCalledTimes(1);
});

it('a failed inline run is not retried by the worker', async () => {
  vi.stubEnv('EXECUTION_MODE', 'inline');
  const provider = new FakeProvider(['unused']);
  vi.spyOn(provider, 'streamChat').mockImplementation(async function* () {
    yield { type: 'error', error: 'provider failed' };
  });
  setChatProviderFactory(() => provider);
  const { runId } = await send();
  await vi.waitFor(async () => {
    expect(await prisma.runEvent.count({ where: { runId, type: 'run.failed' } })).toBe(1);
  });
  expect(await claimNextRun('retry-worker')).toBeNull();
  expect(await prisma.runEvent.count({ where: { runId, type: 'run.started' } })).toBe(1);
});
