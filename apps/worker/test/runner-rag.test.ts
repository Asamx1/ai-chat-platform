import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@aichat/db', async () => ({ prisma: (await import('./rag-fixture')).db }));
vi.mock('../src/lease', async () => (await import('./rag-fixture')).lease);
vi.mock('@aichat/rag', async importOriginal => ({
  ...await importOriginal<typeof import('@aichat/rag')>(),
  retrieve: (await import('./rag-fixture')).retrieve,
}));
import { processRun } from '../src/runner';
import { content, db, events, hits, resetRun, retrieve } from './rag-fixture';

let fake: ReturnType<typeof resetRun>;
beforeEach(() => { fake = resetRun(); });

it('refreshes snapshot hits, sends RAG before the original question and persists citations', async () => {
  await processRun('run', 'worker', fake);
  expect(db.orchestrationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUCCEEDED' } }));
  const messages = fake.stream.mock.calls[0]![0];
  expect(messages.at(-1)).toEqual({ role: 'user', content });
  expect.soft(messages.some(m => m.role === 'user' && /^RAG_DATA_/.test(m.content))).toBe(true);
  expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversation', content);
  expect(db.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({
    status: 'COMPLETE', citations: hits.map(hit => expect.objectContaining({
      documentId: hit.documentId, ordinal: hit.ordinal, text: hit.text,
    })),
  }) });
});

it('continues to SUCCEEDED when retrieval rejects', async () => {
  retrieve.mockRejectedValue(new Error('RAG_UNAVAILABLE'));
  await processRun('run', 'worker', fake);
  expect(db.orchestrationRun.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SUCCEEDED' } }));
  expect(fake.stream.mock.calls[0]![0].at(-1)).toEqual({ role: 'user', content });
  expect(events()).not.toContain('run.failed');
  // Prevent a false green when the baseline never attempts retrieval.
  expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversation', content);
});
