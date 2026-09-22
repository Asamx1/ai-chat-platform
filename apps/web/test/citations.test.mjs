import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './rag-fixture.mjs';
import { parseCitations, parseHeadingPath } from '../src/lib/citation-metadata.ts';
const { injectContext, revalidateContext } = await import('../src/lib/rag-context.ts');
const { applyRunEvent } = await import('../src/components/chat/chat-events.ts');
const { GET } = await import('../src/app/api/conversations/[id]/messages/route.ts');

const hit = { documentId: 'doc', name: 'Guide', ordinal: 2, text: 'A useful source', headingPath: '["Setup","Install"]', distance: 0.125 };
const question = [{ role: 'user', content: 'How?' }];
const capabilities = { maxContext: 8192, maxOutput: 1024 };

test('citations match only sources retained in the provider context budget', () => {
  const hits = Array.from({ length: 5 }, (_, index) => ({ ...hit, ordinal: index, distance: index, text: 'x'.repeat(450) }));
  const prompt = injectContext(question, hits, capabilities);
  const injected = JSON.parse(prompt.messages.at(-2).content.split('\n')[1]);
  assert.ok(injected.length > 0 && injected.length < hits.length);
  assert.deepEqual(prompt.citations.map(item => item.ordinal), injected.map(item => item.ordinal));
  assert.deepEqual(prompt.citations[0].headingPath, ['Setup', 'Install']);
  assert.equal(prompt.citations[0].text, 'x'.repeat(200) + '…');
});

test('no context or no remaining budget produces no citations', () => {
  assert.deepEqual(injectContext(question, [], capabilities).citations, []);
  const prompt = injectContext(question, [hit], { maxContext: 1292, maxOutput: 1000 });
  assert.deepEqual(prompt.messages, question);
  assert.deepEqual(prompt.citations, []);
});

test('heading paths tolerate legacy, malformed and non-string metadata', () => {
  for (const value of [null, undefined, '', '{oops', '{}', '["valid",2]']) {
    assert.deepEqual(parseHeadingPath(value), []);
  }
  assert.deepEqual(parseHeadingPath(hit.headingPath), ['Setup', 'Install']);
  assert.deepEqual(parseCitations([null, {}, { distance: Infinity }]), []);
});

test('completion event retains citations through JSON and leaves user content intact', () => {
  const { citations } = injectContext(question, [hit], capabilities);
  const message = { id: 'assistant', role: 'assistant', content: 'Answer', status: 'streaming' };
  const event = JSON.parse(JSON.stringify({ type: 'run.succeeded', payload: { citations } }));
  const completed = applyRunEvent(message, event, 'retry');
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.content, 'Answer');
  assert.deepEqual(completed.citations, citations);
  assert.deepEqual(parseCitations(JSON.parse(JSON.stringify(completed)).citations), citations);
});

test('revalidation refreshes headings and removes deleted sources before citation creation', async () => {
  fixture.prisma.$queryRaw = async () => [{ ...hit, headingPath: '["Updated"]' }];
  const fresh = await revalidateContext('user', 'conv', { status: 'READY', hits: [hit] });
  assert.deepEqual(injectContext(question, fresh.hits, capabilities).citations[0].headingPath, ['Updated']);
  fixture.prisma.$queryRaw = async () => [];
  const removed = await revalidateContext('user', 'conv', { status: 'READY', hits: [hit] });
  assert.deepEqual(injectContext(question, removed.hits, capabilities).citations, []);
});

test('history returns persisted inline citations as assistant messages and keeps user rows unchanged', async () => {
  const { citations } = injectContext(question, [hit], capabilities);
  fixture.session = { user: { id: 'owner' } };
  fixture.prisma.conversation = { findFirst: async () => ({ id: 'conv' }) };
  fixture.prisma.message = { findMany: async () => [
    { id: 'assistant', content: 'Answer', participantId: null, status: 'COMPLETE', citations, createdAt: new Date() },
    { id: 'user', content: 'How?', participantId: null, status: 'COMPLETE', citations: null, createdAt: new Date() },
  ] };
  const response = await GET(new Request('http://local/api/conversations/conv/messages'), { params: Promise.resolve({ id: 'conv' }) });
  const { items } = await response.json();
  assert.equal(items[0].role, 'user');
  assert.equal(items[1].role, 'assistant');
  assert.deepEqual(items[1].citations, citations);
});
