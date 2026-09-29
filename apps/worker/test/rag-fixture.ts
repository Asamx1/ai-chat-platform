import { vi } from 'vitest';
import { FakeProvider } from '@aichat/providers';

// Existing runner/collab suites use a real test DB and do not export DB stubs.
// Share this minimal persistence boundary across both RAG suites; reuse FakeProvider.
export const content = '原始议题：如何部署服务？';
export const hits = [
  { documentId: 'doc-a', ordinal: 0, name: '部署', text: '先备份再部署。', distance: 0.1 },
  { documentId: 'doc-b', ordinal: 2, name: '恢复', text: '失败时回滚。', distance: 0.2 },
];
export const seats = ['one', 'two'].map(seatId => ({
  id: `participant-${seatId}`, seatId, modelKey: `fake-${seatId}`,
  systemPrompt: `你是席位 ${seatId}`, params: { role: 'member' },
}));
export const retrieve = vi.fn();
export const lease = {
  releaseLease: vi.fn().mockResolvedValue(1),
  renewLease: vi.fn().mockResolvedValue(1),
  shouldCancel: vi.fn().mockResolvedValue(false),
};
export const db = {
  orchestrationRun: { findUnique: vi.fn(), update: vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({})) },
  runParticipantSnapshot: {
    findMany: vi.fn().mockResolvedValue(seats), findFirst: vi.fn().mockResolvedValue(seats[0]),
  },
  runCheckpoint: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
  message: { create: vi.fn().mockResolvedValue({ id: 'assistant' }), update: vi.fn().mockResolvedValue({}) },
  $executeRawUnsafe: vi.fn(async (_sql: string, ..._args: unknown[]) => 1),
  runEvent: { findUnique: vi.fn().mockResolvedValue({ seq: 1 }) },
  providerCall: {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'call' }),
  },
  modelUsageDaily: { upsert: vi.fn().mockResolvedValue({}) },
  usageLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(db)),
};
export function resetRun(collab = false) {
  vi.clearAllMocks();
  retrieve.mockReset().mockResolvedValue(hits);
  db.orchestrationRun.findUnique.mockResolvedValue({
    id: 'run', ownerId: 'owner', conversationId: 'conversation', status: 'RUNNING', attempt: 1,
    degraded: false, degradationReasons: [],
    configSnapshot: {
      content, modelKey: 'fake', rag: { status: 'READY', hits: [
        { ...hits[0], documentId: 'stale-doc', text: '过期快照，必须重新检索' },
      ] },
      ...(collab ? { mode: 'GROUP', seats } : {}),
    },
  });
  const provider = new FakeProvider(['正常回答']);
  const stream = vi.spyOn(provider, 'streamChat');
  return { stream, providerFactory: vi.fn(() => provider) };
}
export function events() {
  return db.$executeRawUnsafe.mock.calls.map(call => call[3]);
}
