import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as f } from './deepseek-fixture.mjs';
const keys = await import('../src/app/api/keys/route.ts');
const models = await import('../src/app/api/models/route.ts');
const secret = 'sk-1234567890abcdefghijkl';
const request = (body = { provider: 'deepseek', apiKey: secret }) => new Request('http://localhost/api/keys', { method: 'POST', body: JSON.stringify(body) });
let rows, writes, fetches;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  f.session = { user: { id: 'user-a' } }; rows = []; writes = []; fetches = [];
  delete process.env.DEEPSEEK_API_KEY;
  f.prisma.apiKey = {
    findMany: async ({ where }) => rows.filter(r => r.userId === where.userId),
    upsert: async (args) => { writes.push(args); rows.push({ ...args.create, updatedAt: new Date('2026-09-20T00:00:00Z') }); },
    deleteMany: async ({ where }) => { const old = rows.length; rows = rows.filter(r => r.userId !== where.userId || r.providerId !== where.providerId); return { count: old - rows.length }; },
  };
  f.prisma.modelRegistry = { findMany: async () => [
    { modelKey: 'deepseek-chat', providerId: 'deepseek', kind: 'cloud', provider: { enabled: true }, capabilities: { label: 'DeepSeek Chat' } },
    { modelKey: 'qwen3:0.6b', providerId: 'ollama', kind: 'local', provider: { enabled: true }, capabilities: {} },
  ] };
  f.prisma.modelUsageDaily = { findMany: async () => [] };
  globalThis.fetch = async (...args) => { fetches.push(args); return new Response(null, { status: 200 }); };
});
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.DEEPSEEK_API_KEY; });
test('all endpoints require a session before accessing data', async () => {
  f.session = null;
  for (const response of [await keys.GET(), await keys.POST(request()), await keys.DELETE(new Request('http://localhost/api/keys?provider=deepseek')), await models.GET()]) {
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
  }
  assert.equal(fetches.length, 0); assert.equal(writes.length, 0);
});
test('POST validates syntax and JSON before connectivity', async () => {
  for (const body of [{ provider: 'other', apiKey: secret }, { provider: 'deepseek', apiKey: 'sk-short' }, null]) {
    assert.equal((await keys.POST(request(body))).status, 400);
  }
  assert.equal((await keys.POST(new Request('http://localhost', { method: 'POST', body: '{' }))).status, 400);
  assert.equal(fetches.length, 0); assert.equal(writes.length, 0);
});
test('200 connectivity stores only encryption output; GET masks and isolates users', async () => {
  const response = await keys.POST(request());
  assert.equal(response.status, 200);
  assert.equal(fetches[0][0], 'https://api.deepseek.com/v1/models');
  assert.equal(fetches[0][1].headers.authorization, `Bearer ${secret}`);
  assert.ok(fetches[0][1].signal instanceof AbortSignal);
  assert.equal(fetches[0][1].redirect, 'error');
  assert.equal(JSON.stringify(writes).includes(secret), false);
  assert.deepEqual(writes[0].where, { userId_providerId: { userId: 'user-a', providerId: 'deepseek' } });
  const listed = await (await keys.GET()).json();
  assert.deepEqual(Object.keys(listed.keys[0]).sort(), ['maskedKey', 'provider', 'updatedAt', 'verified']);
  assert.equal(listed.keys[0].maskedKey, 'sk-123…ijkl');
  f.session.user.id = 'user-b';
  assert.deepEqual(await (await keys.GET()).json(), { keys: [] });
});
for (const [upstream, status, error] of [[401, 401, 'KEY_INVALID'], [500, 502, 'PROVIDER_UNREACHABLE'], [204, 502, 'PROVIDER_UNREACHABLE'], ['timeout', 502, 'PROVIDER_UNREACHABLE']]) {
  test(`connectivity ${upstream}: no persistence`, async () => {
    globalThis.fetch = async () => { if (upstream === 'timeout') throw new DOMException('timed out', 'TimeoutError'); return new Response(null, { status: upstream }); };
    const response = await keys.POST(request());
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error }); assert.equal(writes.length, 0);
  });
}
test('DELETE isolates users and reports absence', async () => {
  await keys.POST(request());
  const req = new Request('http://localhost/api/keys?provider=deepseek');
  f.session.user.id = 'user-b'; assert.equal((await keys.DELETE(req)).status, 404);
  f.session.user.id = 'user-a'; assert.equal((await keys.DELETE(req)).status, 204);
  assert.equal((await keys.DELETE(req)).status, 404);
});
test('models availability tracks DB key, env fallback, deletion, quota and local models', async () => {
  const list = async () => (await (await models.GET()).json()).models;
  assert.equal((await list())[0].available, false);
  assert.equal((await list())[1].quotaRemaining, null);
  process.env.DEEPSEEK_API_KEY = 'env-key'; assert.equal((await list())[0].keySource, 'env');
  await keys.POST(request()); assert.equal((await list())[0].keySource, 'db');
  for (const [tokens, available] of [[200000, true], [200001, false]]) {
    f.prisma.modelUsageDaily.findMany = async ({ where }) => {
      assert.equal(where.userId, 'user-a'); assert.equal(where.date.getUTCHours(), 0);
      return [{ modelId: 'deepseek-chat', tokensIn: tokens, tokensOut: 0 }];
    };
    assert.equal((await list())[0].available, available); assert.equal((await list())[0].quotaRemaining, 0);
  }
  await keys.DELETE(new Request('http://localhost/api/keys?provider=deepseek'));
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal((await list())[0].keySource, null);
});
