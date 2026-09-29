import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as f } from './rag-fixture.mjs';
const { retrieveContext, revalidateContext, injectContext } = await import('../src/lib/rag-context.ts');
const { RETRIEVAL_BUDGET_MS } = await import('../../../packages/rag/src/llm-json.ts');
const { sendChat } = await import('../src/lib/chat-service.ts');
const originalFetch = globalThis.fetch;
const hit = { documentId: 'doc', ordinal: 0, name: 'fact.txt', text: 'The answer is 42', distance: 0.1 };
let mounted, valid, queries, fetches, events, run, done, finish, owned;
const input = { userId: 'user-a', conversationId: 'conv', content: 'Question?', modelKey: 'model', idempotencyKey: 'once' };
beforeEach(() => {
  delete process.env.EXECUTION_MODE;
  mounted = true; valid = true; owned = true; queries = []; fetches = []; events = []; run = null; f.prompts = [];
  done = new Promise(resolve => { finish = resolve; });
  f.prisma.$queryRaw = async (strings, ...values) => {
    const sql = strings.join('?'); queries.push({ sql, values });
    return sql.includes('FROM "Chunk"') ? (valid ? [{ documentId: hit.documentId, ordinal: hit.ordinal, name: hit.name, text: hit.text }] : []) : (mounted ? [{ kbId: 'kb' }] : []);
  };
  f.prisma.$transaction = async fn => fn(f.prisma);
  f.prisma.conversation = { findUnique: async () => ({ id: 'conv', ownerId: owned ? 'user-a' : 'other' }) };
  f.prisma.message = { create: async () => ({ id: 'message' }) };
  f.prisma.orchestrationRun = {
    findUnique: async ({ where }) => where.id ? { ...run, leaseOwner: null, cancelRequested: false } : run,
    create: async ({ data }) => { run = { id: 'run', ...data }; return run; },
    update: async ({ data }) => { Object.assign(run, data); return run; },
  };
  f.prisma.runEvent = { create: async ({ data }) => { events.push(data); if (['run.succeeded', 'run.failed'].includes(data.type)) finish(); } };
  f.prisma.runParticipantSnapshot = { findFirst: async () => ({ id: 'seat' }) };
  f.prisma.providerCall = { create: async () => ({ id: 'call' }) };
  f.prisma.modelUsageDaily = { upsert: async () => ({}) };
  f.prisma.usageLog = { create: async () => ({}) };
  globalThis.fetch = async (url, options) => { fetches.push({ url, options }); return Response.json([hit]); };
});
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.EXECUTION_MODE; });
async function complete() {
  let timer;
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('inline did not finish')), 2000); })]); }
  finally { clearTimeout(timer); }
}
test('unmounted conversation skips retrieval; mounted query uses authenticated identities and TopK=5', async () => {
  mounted = false;
  assert.deepEqual(await retrieveContext('user-a', 'conv', 'query'), { status: 'SKIPPED', hits: [] });
  assert.equal(fetches.length, 0);
  mounted = true;
  globalThis.fetch = async (url, options) => { fetches.push({url, options}); return Response.json(Array.from({ length: 8 }, (_, i) => ({ ...hit, ordinal: i, distance: 8 - i }))); };
  const result = await retrieveContext('user-a', 'conv', 'query');
  assert.deepEqual(result.hits.map(row => row.ordinal), [7, 6, 5, 4, 3]);
  assert.deepEqual(JSON.parse(fetches[0].options.body), { userId: 'user-a', conversationId: 'conv', query: 'query' });
  assert.deepEqual(queries[0].values, ['conv', 'user-a', 'user-a']);
});
test('retrieval errors and eight-second deadline degrade without exposing errors', async t => {
  globalThis.fetch = async () => { throw new Error('/private/path'); };
  assert.deepEqual(await retrieveContext('user-a', 'conv', 'q'), { status: 'RAG_UNAVAILABLE', hits: [] });
  globalThis.fetch = async () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = retrieveContext('user-a', 'conv', 'q');
  t.mock.timers.tick(RETRIEVAL_BUDGET_MS);
  assert.deepEqual(await pending, { status: 'RAG_UNAVAILABLE', hits: [] });
});
test('revalidation checks live chunks, READY/model, ownership and mount, and discards deleted documents', async () => {
  const snapshot = { status: 'READY', hits: [{ ...hit, text: 'stale' }] };
  assert.equal((await revalidateContext('user-a', 'conv', snapshot)).hits[0].text, hit.text);
  assert.match(queries[0].sql, /d.status = 'READY'/); assert.match(queries[0].sql, /ConversationKnowledgeBase/);
  assert.deepEqual(queries[0].values, ['doc', 0, 'bge-m3:latest', 'user-a', 'user-a', 'conv']);
  valid = false; assert.deepEqual((await revalidateContext('user-a', 'conv', snapshot)).hits, []);
  f.prisma.$queryRaw = async () => { throw new Error('db'); };
  assert.equal((await revalidateContext('user-a', 'conv', snapshot)).status, 'RAG_UNAVAILABLE');
});
test('injection preserves original system/history/question and serializes data with source fields', () => {
  const messages = [{ role: 'system', content: 'Original' }, { role: 'user', content: 'History' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Question' }];
  const prompt = injectContext(messages, [hit], { maxContext: 8192, maxOutput: 1000 });
  assert.equal(prompt.maxTokens, 1000); assert.equal(prompt.messages[0].content, 'Original');
  assert.match(prompt.messages[1].content, /引用\[documentId:ordinal\]/);
  assert.equal(prompt.messages.at(-1).content, 'Question');
  const [start, data, end] = prompt.messages.at(-2).content.split('\n');
  assert.match(start, /^RAG_DATA_[a-f0-9]{32}$/);
  assert.equal(end, `END_${start}`);
  assert.deepEqual(JSON.parse(data), [hit]);
  assert.equal(messages.length, 4);
});
test('budget uses UTF-8 bytes plus overhead, trims distant hits and drops RAG before rejecting original context', () => {
  const messages = [{ role: 'user', content: '问' }];
  const prompt = injectContext(messages, Array.from({length: 5}, (_, ordinal) => ({ ...hit, ordinal, text: 'x'.repeat(450), distance: ordinal })), { maxContext: 10000, maxOutput: 4096 });
  assert.equal(prompt.maxTokens, 2048);
  const selected = JSON.parse(prompt.messages.at(-2).content.split('\n')[1]);
  assert.ok(selected.length > 0 && selected.length < 5); assert.equal(selected[0].ordinal, 0);
  const ragCost = prompt.messages.slice(0, -1).reduce((sum, msg) => sum + Buffer.byteLength(msg.content) + 32, 0);
  assert.ok(ragCost <= 2048);
  const tight = { maxContext: 1291, maxOutput: 1000 }; // 3 + 32 input, 1000 output, 256 reserve.
  assert.deepEqual(injectContext(messages, [hit], tight).messages, messages);
  assert.throws(() => injectContext(messages, [], { ...tight, maxContext: 1290 }), { message: 'CONTEXT_TOO_LONG' });
});
test('sendChat snapshots retrieval before execution and provider receives revalidated citation context and maxTokens', async () => {
  await sendChat(input); await complete();
  assert.equal(run.status, 'SUCCEEDED'); assert.deepEqual(run.configSnapshot.rag, { status: 'READY', hits: [hit] });
  assert.equal(fetches.length, 1); assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].options.maxTokens, 1024);
  assert.match(f.prompts[0].messages.at(-2).content, /RAG_DATA/); assert.equal(f.prompts[0].messages.at(-1).content, input.content);
  assert.ok(queries.some(query => query.sql.includes('FROM "Chunk"')));
  assert.deepEqual(events.map(row => row.type), ['run.started', 'provider.delta', 'run.succeeded']);
});
test('idempotent replay reuses stored run without retrieval; cross-user conversations fail before retrieval', async () => {
  owned = false; await assert.rejects(sendChat(input), { name: 'ChatNotFoundError' }); assert.equal(fetches.length, 0);
  owned = true; await sendChat(input); await complete();
  const before = fetches.length; const res = await sendChat(input);
  assert.equal(res.runId, 'run'); assert.equal(fetches.length, before); assert.equal(f.prompts.length, 1);
});
test('unmounted and deleted-after-snapshot documents never reach provider', async () => {
  valid = false;
  await sendChat(input); await complete();
  assert.equal(run.configSnapshot.rag.hits.length, 1);
  assert.deepEqual(f.prompts[0].messages, [{ role: 'user', content: input.content }]);
});
test('retrieval failure persists and emits RAG_UNAVAILABLE while chat succeeds', async () => {
  globalThis.fetch = async () => { throw new Error('/private/path'); };
  await sendChat(input); await complete();
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.degraded, true);
  assert.deepEqual(run.degradationReasons, ['RAG_UNAVAILABLE']);
  assert.deepEqual(run.configSnapshot.rag, { status: 'RAG_UNAVAILABLE', hits: [] });
  assert.ok(events.some(event => event.type === 'run.degraded' && event.payload.reason === 'RAG_UNAVAILABLE'));
  assert.deepEqual(f.prompts[0].messages, [{ role: 'user', content: input.content }]);
});
test('oversized original prompt fails with CONTEXT_TOO_LONG before provider call', async () => {
  await sendChat({ ...input, content: '汉'.repeat(3000) }); await complete();
  assert.equal(run.status, 'FAILED'); assert.equal(f.prompts.length, 0);
  assert.deepEqual(events.at(-1).payload, { error: 'CONTEXT_TOO_LONG' });
});
test('worker mode persists RAG snapshot but does not run inline', async () => {
  process.env.EXECUTION_MODE = 'worker';
  await sendChat(input);
  assert.equal(run.status, 'PENDING'); assert.deepEqual(run.configSnapshot.rag, { status: 'READY', hits: [hit] });
  assert.equal(f.prompts.length, 0);
});
