import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as f } from './deepseek-fixture.mjs';
const { sendChat } = await import('../src/lib/chat-service.ts');
const { loadPrompt, processRun, recordUsage } = await import('../../worker/src/runner.ts');
const { processCollabRun } = await import('../../worker/src/collab-runner.ts');
let run, messages, participants, events, calls, daily, logs, transactions;
beforeEach(() => {
  process.env.EXECUTION_MODE = 'worker';
  f.prompts = []; f.resolutions = []; delete f.resolve;
  f.resolved = { adapter: 'openai-compatible', modelId: 'deepseek-chat', apiKey: 'secret', baseUrl: 'https://api.deepseek.com/v1' };
  messages = []; participants = []; events = []; calls = []; daily = []; logs = []; transactions = 0;
  run = { id: 'run-a', ownerId: 'user-a', conversationId: 'conversation-a', status: 'RUNNING', attempt: 1, configSnapshot: { modelKey: 'deepseek-chat', content: 'question' } };
  Object.assign(f.prisma, {
    conversation: { findUnique: async () => ({ id: 'conversation-a', ownerId: 'user-a' }) },
    orchestrationRun: {
      findUnique: async ({ where }) => where.ownerId_idempotencyKey ? null : run,
      create: async ({ data }) => { run = { ...run, ...data }; participants.push({ id: 'snapshot-a', runId: run.id, ...data.participantSnapshots.create }); return run; },
      update: async ({ data }) => Object.assign(run, data),
    },
    message: {
      create: async ({ data }) => { const row = { id: 'message-' + messages.length, ...data }; messages.push(row); return row; },
      findFirst: async ({ where }) => messages.find(m => m.id === where.id && m.conversationId === where.conversationId),
      update: async () => {},
    },
    runParticipantSnapshot: {
      findFirst: async ({ where }) => participants.find(p => p.runId === where.runId && p.seatId === where.seatId),
      findMany: async () => participants,
    },
    runCheckpoint: { findFirst: async () => null, create: async () => ({}) },
    runEvent: { findUnique: async () => ({ seq: events.length }) },
    $executeRawUnsafe: async (sql, ...args) => { if (sql.includes('INSERT INTO "RunEvent"')) events.push({ type: args[2], payload: JSON.parse(args[3]) }); return 1; },
    providerCall: {
      createMany: async ({ data }) => { if (calls.some(c => c.requestHash === data[0].requestHash)) return { count: 0 }; calls.push({ id: 'call-' + calls.length, ...data[0] }); return { count: 1 }; },
      findUniqueOrThrow: async ({ where }) => calls.find(c => c.requestHash === where.requestHash),
    },
    modelUsageDaily: { upsert: async ({ create, update }) => {
      const row = daily.find(d => d.userId === create.userId && d.modelId === create.modelId && +d.date === +create.date);
      if (row) { row.tokensIn += update.tokensIn.increment; row.tokensOut += update.tokensOut.increment; }
      else daily.push({ ...create });
    } },
    usageLog: { create: async ({ data }) => { logs.push(data); } },
    $transaction: async (fn) => {
      transactions++;
      const backup = structuredClone({ calls, daily, logs });
      try { return await fn(f.prisma); } catch (error) { ({ calls, daily, logs } = backup); throw error; }
    },
  });
});
test('B1: sendChat persists content; worker resolves and streams that nonempty prompt', async () => {
  const result = await sendChat({ userId: 'user-a', conversationId: 'conversation-a', content: 'actual question', modelKey: 'deepseek-chat', idempotencyKey: 'test-b1' });
  assert.equal(run.configSnapshot.content, 'actual question'); assert.equal(run.status, 'PENDING'); assert.equal(result.meta, undefined);
  await processRun(result.runId, 'worker-a');
  assert.equal(f.prompts[0].messages[0].content, 'actual question');
  assert.deepEqual(f.resolutions, [['user-a', 'deepseek-chat'], ['user-a', 'deepseek-chat']]);
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(transactions, 1);
  assert.equal(calls[0].participantSnapshotId, 'snapshot-a'); assert.equal(daily[0].tokensIn, 11); assert.equal(daily[0].tokensOut, 7);
});
test('legacy snapshot recovers its referenced message, constrained to the conversation', async () => {
  messages.push({ id: 'old', conversationId: 'conversation-a', content: 'old prompt' });
  run.configSnapshot = { modelKey: 'deepseek-chat', userMessageId: 'old', content: ' ' };
  await processRun(run.id, 'worker-a');
  assert.equal(f.prompts[0].messages[0].content, 'old prompt');
  await assert.rejects(loadPrompt('other-conversation', run.configSnapshot), /EMPTY_PROMPT/);
});
test('empty prompt fails run without resolver or upstream call', async () => {
  run.configSnapshot.content = ' ';
  await processRun(run.id, 'worker-a');
  assert.equal(run.status, 'FAILED'); assert.equal(f.prompts.length, 0); assert.equal(f.resolutions.length, 0);
  assert.ok(events.some(e => e.type === 'run.failed' && e.payload.error === 'EMPTY_PROMPT'));
});
test('degraded response metadata and worker usage identify the actual local model', async () => {
  f.resolved = { adapter: 'ollama', baseUrl: 'http://localhost:11434', modelId: 'qwen3:0.6b', degraded: { reason: 'NO_KEY', from: 'deepseek-chat' } };
  const result = await sendChat({ userId: 'user-a', conversationId: 'conversation-a', content: 'question', modelKey: 'deepseek-chat', idempotencyKey: 'test-degrade' });
  assert.deepEqual(result.meta.degraded, f.resolved.degraded);
  await processRun(run.id, 'worker-a');
  assert.equal(daily[0].modelId, 'qwen3:0.6b'); assert.equal(run.degraded, true);
  assert.ok(events.some(e => e.type === 'run.degraded'));
});
test('accounting deduplicates replay, sums calls and rolls back if logging fails', async () => {
  const usage = { runId: run.id, ownerId: run.ownerId, modelKey: 'deepseek-chat', attempt: 1, content: 'question', tokens: 18, usage: { promptTokens: 11, completionTokens: 7 }, participantSnapshotId: 'seat-snapshot' };
  await recordUsage(usage); await recordUsage(usage); await recordUsage({ ...usage, invocation: 1 });
  assert.equal(calls.length, 2); assert.equal(logs.length, 2); assert.equal(daily[0].tokensIn, 22); assert.equal(daily[0].tokensOut, 14);
  assert.equal(calls[0].participantSnapshotId, 'seat-snapshot'); assert.equal(daily[0].date.getUTCHours(), 0);
  f.prisma.usageLog.create = async () => { throw new Error('write failed'); };
  await assert.rejects(recordUsage({ ...usage, invocation: 2 }), /write failed/);
  assert.equal(calls.length, 2); assert.equal(daily[0].tokensIn, 22);
});
test('collaboration recovers legacy content and accounts before resolving the next seat', async () => {
  run.configSnapshot = { mode: 'GROUP', seats: ['a', 'b'], userMessageId: 'old' };
  messages.push({ id: 'old', conversationId: run.conversationId, content: 'collab question' });
  participants = ['a', 'b'].map(seatId => ({ id: 'snapshot-' + seatId, runId: run.id, seatId, modelKey: 'deepseek-chat', systemPrompt: '', params: {} }));
  f.resolve = () => { if (f.resolutions.length === 2) assert.equal(daily[0].tokensIn, 11); return f.resolved; };
  await processCollabRun(run.id, 'worker-a');
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(f.prompts.length, 2);
  assert.equal(f.prompts[0].messages[0].content, 'collab question');
  assert.deepEqual(calls.map(c => c.participantSnapshotId), ['snapshot-a', 'snapshot-b']);
  assert.equal(daily[0].tokensIn, 22);
});
test('collaboration also fails EMPTY_PROMPT before calling any model', async () => {
  run.configSnapshot = { mode: 'GROUP', seats: ['a', 'b'], content: '' };
  participants = ['a', 'b'].map(seatId => ({ id: seatId, runId: run.id, seatId, modelKey: 'deepseek-chat', params: {} }));
  await processCollabRun(run.id, 'worker-a');
  assert.equal(run.status, 'FAILED'); assert.equal(f.prompts.length, 0);
  assert.ok(events.some(e => e.payload.error === 'EMPTY_PROMPT'));
});
