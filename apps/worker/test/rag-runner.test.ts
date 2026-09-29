import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@aichat/providers';
const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(), run: {} as Record<string, unknown>, prompts: [] as ChatMessage[][],
  create: vi.fn(), update: vi.fn(), checkpoint: vi.fn(), messageUpdate: vi.fn(),
}));
vi.mock('@aichat/rag', async () => ({
  ...await import('../../../packages/rag/src/inject'), retrieve: mocks.retrieve,
}));
vi.mock('@aichat/db', () => ({ prisma: {
  orchestrationRun: { findUnique: async () => mocks.run, update: mocks.update, updateMany: async () => ({ count: 1 }) },
  runCheckpoint: { findFirst: mocks.checkpoint, create: async () => ({}) },
  message: { create: mocks.create, update: mocks.messageUpdate },
  runEvent: { findUnique: async () => ({ seq: 1 }) },
  $executeRawUnsafe: async () => 1,
  runParticipantSnapshot: { findMany: async () => ['a', 'b'].map(seatId => ({ id: seatId, seatId, modelKey: seatId, systemPrompt: `System ${seatId}`, params: {} })) },
} }));
vi.mock('../src/lease', () => ({ releaseLease: vi.fn(), renewLease: async () => 1, shouldCancel: async () => false }));
vi.mock('@aichat/providers/quota-provider', () => ({ quotaProvider: () => ({
  capabilities: () => ({ maxContext: 8192, maxOutput: 1024 }),
  async *streamChat(messages: ChatMessage[]) {
    mocks.prompts.push(messages);
    yield { type: 'text-delta', delta: 'answer' };
    yield { type: 'done' };
  },
}) }));
vi.mock('@aichat/orchestrator', () => ({
  CollabCancelledError: class extends Error {},
  async *runOrchestration({ seats, callModel, userContent }: any) {
    for (const seat of seats) await callModel(seat, userContent);
    // Another round exercises repeated calls without mutating the source prompt.
    await callModel(seats[0], userContent);
    yield { type: 'final', output: 'combined', degraded: false };
  },
}));
import { processRun, retrieveRunContext } from '../src/runner';
import { processCollabRun } from '../src/collab-runner';
const hit = { documentId: 'doc', ordinal: 0, name: 'Guide', text: 'Fresh evidence', distance: 0.1, headingPath: '["Chapter"]' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.prompts = [];
  mocks.run = { id: 'run', ownerId: 'owner', conversationId: 'conversation', attempt: 1, status: 'RUNNING', degradationReasons: [],
    configSnapshot: { modelKey: 'model', content: 'Question', rag: { status: 'READY', hits: [{ ...hit, text: 'Stale' }] } } };
  mocks.retrieve.mockResolvedValue([hit]);
  mocks.create.mockResolvedValue({ id: 'assistant' });
  mocks.checkpoint.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());
it('refreshes worker evidence, leaves question last and persists matching citations on recovery', async () => {
  mocks.checkpoint.mockResolvedValue({ version: 1, stateJson: { assistantMessageId: 'assistant', accumulated: 'partial' } });
  await processRun('run', 'worker');
  expect(mocks.retrieve).toHaveBeenCalledWith('owner', 'conversation', 'Question');
  const messages = mocks.prompts[0]!;
  expect(messages.at(-1)?.content).toBe('Question');
  expect(messages.at(-2)?.content).toMatch(/^RAG_DATA_/);
  expect(messages.at(-2)?.content).toContain('Fresh evidence');
  expect(messages.at(-2)?.content).not.toContain('Stale');
  expect(mocks.messageUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ citations: [expect.objectContaining({ documentId: 'doc', headingPath: ['Chapter'] })] }) }));
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUCCEEDED' } }));
});
it.each([false, true])('retrieval failure does not fail the run (collab=%s)', async collab => {
  mocks.retrieve.mockRejectedValue(new Error('unavailable'));
  if (collab) mocks.run.configSnapshot = { mode: 'GROUP', seats: ['a', 'b'], content: 'Question' };
  await (collab ? processCollabRun : processRun)('run', 'worker');
  expect(mocks.prompts.length).toBeGreaterThan(0);
  expect(mocks.prompts.flat().some(message => message.content.startsWith('RAG_DATA_'))).toBe(false);
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUCCEEDED' } }));
  if (collab) expect(mocks.update.mock.calls.some(([args]) => args.data.degraded)).toBe(false);
});
it('all collaboration seats and rounds share one envelope, with empty final citations', async () => {
  mocks.run.configSnapshot = { mode: 'GROUP', seats: ['a', 'b'], content: 'Question' };
  await processCollabRun('run', 'worker');
  expect(mocks.retrieve).toHaveBeenCalledTimes(1);
  expect(mocks.prompts).toHaveLength(3);
  const envelopes = mocks.prompts.map(messages => {
    expect(messages[0]?.role).toBe('system');
    expect(messages.at(-1)?.content).toBe('Question');
    const data = messages.filter(message => message.content.startsWith('RAG_DATA_'));
    expect(data).toHaveLength(1);
    expect(data[0]?.role).toBe('user');
    return data[0]?.content;
  });
  expect(new Set(envelopes).size).toBe(1);
  expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ citations: [], content: 'combined' }) });
});
it('bounds a hung retrieval at ten seconds', async () => {
  vi.useFakeTimers(); mocks.retrieve.mockReturnValue(new Promise(() => {}));
  const work = retrieveRunContext('owner', 'conversation', 'Question');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await work).toEqual({ hits: [], unavailable: true });
  expect(vi.getTimerCount()).toBe(0);
});

it('resumed collaboration with an existing envelope does not add a second one', async () => {
  mocks.run.configSnapshot = { mode: 'GROUP', seats: ['a', 'b'], content: 'RAG_DATA_existing\n[]\nEND_RAG_DATA_existing\nQuestion' };
  await processCollabRun('run', 'worker');
  for (const messages of mocks.prompts) {
    expect(messages.filter(message => message.content.startsWith('RAG_DATA_'))).toHaveLength(1);
    expect(messages.at(-1)?.content).toContain('RAG_DATA_existing');
  }
});
it('empty fresh results discard stale snapshot citations', async () => {
  mocks.retrieve.mockResolvedValue([]);
  await processRun('run', 'worker');
  expect(mocks.prompts[0]).toEqual([{ role: 'user', content: 'Question' }]);
  expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ citations: [] }) });
});
