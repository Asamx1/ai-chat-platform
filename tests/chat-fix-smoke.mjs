import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const root = pathToFileURL(process.cwd() + '/');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@aichat/crypto/constants') return { url: new URL('packages/crypto/src/constants.ts', root).href, shortCircuit: true };
  return next(specifier, context);
} });
const { createResolver } = await import(new URL('packages/providers/src/resolver.ts', root));
const { applyRunEvent, sendFailure } = await import(new URL('apps/web/src/components/chat/chat-events.ts', root));
const { OllamaProvider } = await import(new URL('packages/providers/src/ollama.ts', root));
const local = { id: 'registry-local', modelKey: 'qwen3:0.6b', providerId: 'ollama', kind: 'local', provider: { kind: 'ollama', baseUrl: 'http://test' } };
function setup(row = local, exact = false) {
  const calls = [];
  const db = {
    modelRegistry: { findUnique: async () => exact ? row : null, findFirst: async args => { calls.push(args); return row; } },
    apiKey: { findUnique: async () => null },
    modelUsageDaily: { findUnique: async args => { calls.push(args); return null; } },
  };
  return { resolver: createResolver(db, { env: { DEEPSEEK_API_KEY: 'key' } }), calls, db };
}
test('modelKey fallback selects enabled provider and returns canonical id', async () => {
  const { resolver, calls } = setup();
  const result = await resolver.resolve('u', local.modelKey);
  assert.equal(result.modelId, local.id); assert.equal(result.model, local.modelKey);
  assert.deepEqual(calls[0], { where: { modelKey: local.modelKey, provider: { enabled: true } }, include: { provider: true }, orderBy: { updatedAt: 'desc' } });
});
test('exact id takes precedence without fallback', async () => {
  const { resolver, calls } = setup(local, true);
  assert.equal((await resolver.resolve('u', local.id)).modelId, local.id); assert.equal(calls.length, 0);
});
test('unknown model is readable 400', async () => {
  await assert.rejects(setup(null).resolver.resolve('u', 'missing'), e => e.status === 400 && e.code === 'UNKNOWN_MODEL' && e.message.includes('模型'));
});
test('cloud quota lookup uses canonical registry id for legacy input', async () => {
  const cloud = { ...local, id: 'cloud-registry', modelKey: 'deepseek-chat', kind: 'cloud', providerId: 'deepseek' };
  const { resolver, calls } = setup(cloud);
  assert.equal((await resolver.resolve('u', cloud.modelKey)).modelId, cloud.id);
  assert.equal(calls[1].where.userId_modelId_date.modelId, cloud.id);
});
test('missing local degradation target is readable 503', async () => {
  const { resolver, db } = setup({ ...local, kind: 'cloud', providerId: 'other' }, true);
  db.modelRegistry.findFirst = async () => null;
  await assert.rejects(resolver.resolve('u', 'cloud'), e => e.status === 503 && e.message.includes('本地回退模型'));
});
test('HTTP error body and non-JSON fallback are visible', async () => {
  for (const status of [400, 503]) assert.equal(await sendFailure(Response.json({ error: '模型不可用' }, { status })), '模型不可用');
  assert.match(await sendFailure(new Response('bad', { status: 502 })), /HTTP 502/);
});
test('SSE payload deltas, failure reason and terminal state survive', () => {
  let message = { id: 'a', role: 'assistant', content: '', status: 'streaming' };
  message = applyRunEvent(message, { type: 'provider.delta', payload: { delta: 'hello' } }, 'r');
  message = applyRunEvent(message, { type: 'run.failed', payload: { error: '模型失败' } }, 'r');
  assert.equal(message.content, 'hello'); assert.equal(message.error, '模型失败'); assert.equal(message.status, 'failed');
  assert.equal(applyRunEvent(message, { type: 'run.succeeded' }, 'r').status, 'succeeded');
});
test('resolved provider model name produces correct Ollama request', async () => {
  const resolved = await setup().resolver.resolve('u', local.modelKey);
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response('{"message":{"content":"ok"},"done":true}\n'); };
  try {
    const provider = new OllamaProvider({ baseUrl: resolved.baseUrl, model: resolved.model });
    for await (const event of provider.streamChat([{ role: 'user', content: 'hi' }])) assert.notEqual(event.type, 'error');
    assert.equal(body.model, local.modelKey);
  } finally { globalThis.fetch = original; }
});
