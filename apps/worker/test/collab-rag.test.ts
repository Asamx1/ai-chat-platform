import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollabCallModel, OrchestratorSeat } from '@aichat/orchestrator';
vi.mock('@aichat/db', async () => ({ prisma: (await import('./rag-fixture')).db }));
vi.mock('../src/lease', async () => (await import('./rag-fixture')).lease);
vi.mock('@aichat/rag', async importOriginal => ({
  ...await importOriginal<typeof import('@aichat/rag')>(),
  retrieve: (await import('./rag-fixture')).retrieve,
}));
vi.mock('@aichat/orchestrator', async importOriginal => ({
  ...await importOriginal<typeof import('@aichat/orchestrator')>(),
  async *runOrchestration(opts: { seats: OrchestratorSeat[]; userContent: string; callModel: CollabCallModel }) {
    for (const seat of opts.seats) await opts.callModel(seat, opts.userContent);
    yield { type: 'final', output: '双席位汇总', degraded: false, reasons: [] };
  },
}));
import { processCollabRun } from '../src/collab-runner';
import { content, db, events, resetRun, retrieve } from './rag-fixture';

let fake: ReturnType<typeof resetRun>;
beforeEach(() => { fake = resetRun(true); });
afterEach(() => { vi.useRealTimers(); });
function expectCompleted() {
  expect(db.orchestrationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUCCEEDED' } }));
  expect(db.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    content: '双席位汇总', status: 'COMPLETE', citations: [],
  }) });
  expect(fake.stream).toHaveBeenCalledTimes(2);
  expect(events().filter(type => /degraded|failed/.test(String(type)))).toEqual([]);
  for (const [args] of db.orchestrationRun.update.mock.calls) expect(args.data.degraded).not.toBe(true);
}

it('retrieves once and gives both seats one evidence block with the same nonce', async () => {
  await processCollabRun('run', 'worker', fake);
  expectCompleted();
  const nonces = fake.stream.mock.calls.map(([messages]) => {
    expect(messages.at(-1)).toEqual({ role: 'user', content });
    const blocks = messages.filter(m => m.role === 'user' && /^RAG_DATA_/.test(m.content));
    expect(blocks).toHaveLength(1);
    const nonce = /^RAG_DATA_([^\n]+)\n/.exec(blocks[0]!.content)![1];
    expect(blocks[0]!.content).toContain(`END_RAG_DATA_${nonce}`);
    expect(blocks[0]!.content).toContain('doc-a');
    expect(blocks[0]!.content).toContain('doc-b');
    return nonce;
  });
  expect(nonces[0]).toBe(nonces[1]);
  expect(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversation', content);
});

it('retrieval exceptions do not fail or degrade collaboration', async () => {
  retrieve.mockRejectedValue(new Error('retrieval unavailable'));
  await processCollabRun('run', 'worker', fake);
  expectCompleted();
  expect(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversation', content);
});

it('a hanging retrieval times out within 10 seconds without degradation', async () => {
  vi.useFakeTimers();
  retrieve.mockImplementation(() => new Promise(() => {}));
  let settled = false;
  const running = processCollabRun('run', 'worker', fake).then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(10_001);
  expect(settled).toBe(true);
  await running;
  expectCompleted();
  expect(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversation', content);
});
