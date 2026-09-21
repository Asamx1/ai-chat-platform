import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as f } from './rag-fixture.mjs';
const kb = await import('../src/app/api/kb/route.ts');
const detail = await import('../src/app/api/kb/[id]/route.ts');
const mount = await import('../src/app/api/conversations/[id]/kb/route.ts');
const storage = await import('../src/lib/minio.ts');
const { validateFile } = await import('../src/lib/kb-api.ts');
const originalFetch = globalThis.fetch;
let queries, writes, fetches, owned, mounts, failDocument;
const context = id => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://localhost/api/kb');
const json = kbIds => new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ kbIds }) });
function upload({ name = 'fact.txt', mime = 'text/plain', data = 'hello', fields = { name: 'Knowledge' } } = {}) {
  const body = new FormData();
  body.append('file', new File([data], name, { type: mime }));
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request('http://localhost/api/kb', { method: 'POST', body });
}
const document = { id: 'doc', name: 'fact.txt', status: 'PENDING', chunkCount: 0, createdAt: new Date('2026-09-21'), error: null };
beforeEach(() => {
  f.session = { user: { id: 'user-a' } }; f.sdk = [];
  queries = []; writes = []; fetches = []; owned = true; mounts = ['old']; failDocument = false;
  Object.assign(process.env, { S3_ENDPOINT: 'http://minio.test:9000', S3_BUCKET: 'private', MINIO_ROOT_USER: 'user', MINIO_ROOT_PASSWORD: 'password' });
  f.prisma.$queryRaw = async (strings, ...values) => {
    const sql = strings.join('?'); queries.push({ sql, values });
    if (sql.includes('INSERT INTO "Document"')) { if (failDocument) throw new Error('/private/db'); return [document]; }
    if (sql.includes('count(*)')) return [{ total: 1n }];
    if (sql.includes('FROM "Document"')) return [{ ...document, error: '/private/parser/path' }];
    if (sql.includes('FROM "ConversationKnowledgeBase"')) return mounts.map(kbId => ({ kbId }));
    if (sql.includes('FROM "Conversation"')) return owned ? [{ id: values[0] }] : [];
    if (sql.includes('FROM "KnowledgeBase"')) return owned && !values.includes('foreign') ? [{ id: 'kb', name: 'Knowledge' }] : [];
    throw new Error('unexpected SQL: ' + sql);
  };
  f.prisma.$executeRaw = async (strings, ...values) => {
    const sql = strings.join('?'); writes.push({ sql, values });
    if (sql.includes('DELETE FROM "ConversationKnowledgeBase"')) mounts = [];
    if (sql.includes('INSERT INTO "ConversationKnowledgeBase"')) mounts.push(values[1]);
    return 1;
  };
  f.prisma.$transaction = async fn => { const old = [...mounts]; try { return await fn(f.prisma); } catch (err) { mounts = old; throw err; } };
  globalThis.fetch = async (url, options) => { fetches.push({ url, options }); return new Response('stored'); };
});
afterEach(() => { globalThis.fetch = originalFetch; for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']) delete process.env[key]; });
test('all six handlers authenticate before database/storage access', async () => {
  f.session = null;
  for (const res of [await kb.GET(req()), await kb.POST(upload()), await detail.GET(req(), context('kb')), await detail.DELETE(req(), context('kb')), await mount.GET(req(), context('conv')), await mount.PUT(json([]), context('conv'))]) {
    assert.equal(res.status, 401); assert.deepEqual(await res.json(), { error: 'UNAUTHORIZED' });
  }
  assert.equal(queries.length + writes.length + fetches.length, 0);
});
test('list pagination, explicit document projection and error sanitization', async () => {
  const res = await kb.GET(new Request('http://localhost/api/kb?offset=2&limit=5'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1);
  assert.deepEqual(body.items[0].documents[0], { ...document, createdAt: document.createdAt.toISOString(), error: 'DOCUMENT_PROCESSING_FAILED' });
  assert.deepEqual(queries[0].values, ['user-a', 2, 5]);
  for (const query of ['limit=101', 'offset=-1', 'offset=1.5', 'limit=0', 'offset=9007199254740992']) assert.equal((await kb.GET(new Request('http://localhost?' + query))).status, 400);
});
test('detail and deletion reject foreign/missing knowledge bases', async () => {
  owned = false;
  for (const res of [await detail.GET(req(), context('foreign')), await detail.DELETE(req(), context('foreign')), await kb.POST(upload({ fields: { kbId: 'foreign' } }))]) assert.equal(res.status, 404);
  assert.equal(writes.length + fetches.length, 0);
  assert.ok(queries.every(query => query.values.includes('user-a')));
});
test('detail returns projected documents; deletion uses owner-guarded transactional cascade', async () => {
  assert.equal((await detail.GET(req(), context('kb'))).status, 200);
  assert.equal((await detail.DELETE(req(), context('kb'))).status, 204);
  assert.deepEqual(writes[0].values, ['kb', 'user-a']);
  assert.match(writes[0].sql, /DELETE FROM "KnowledgeBase"/);
  assert.equal(fetches.length, 0);
});
for (const [name, mime, data] of [['fact.txt', 'text/plain', '事实'], ['fact.md', 'text/markdown', '# fact'], ['fact.pdf', 'application/pdf', '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n']]) {
  test(`upload ${name} creates a pending document and scoped private object`, async () => {
    const res = await kb.POST(upload({ name, mime, data })); assert.equal(res.status, 202);
    const body = await res.json(); assert.equal(body.document.status, 'PENDING'); assert.equal(body.document.chunkCount, 0);
    assert.equal(body.document.error, null);
    assert.equal(fetches.length, 1); assert.match(fetches[0].url, new RegExp('/private/user-a/' + body.kbId + '/'));
    assert.equal(fetches[0].options.headers['Content-Type'], mime);
    assert.equal(writes.filter(write => write.sql.includes('INSERT INTO "KnowledgeBase"')).length, 1);
    assert.equal(f.sdk[0].port, 9000);
  });
}
test('existing KB upload does not create another KB and rechecks ownership in write transaction', async () => {
  assert.equal((await kb.POST(upload({ fields: { kbId: 'kb' } }))).status, 202);
  assert.equal(queries.filter(query => query.sql.includes('FOR UPDATE')).length, 2);
  assert.ok(!writes.some(write => write.sql.includes('INSERT INTO "KnowledgeBase"')));
});
test('invalid multipart shape, blank file and MIME/content mismatches do not write storage', async () => {
  for (const options of [{ fields: {} }, { fields: { name: 'x', kbId: 'kb' } }, { fields: { name: ' ' } }]) assert.equal((await kb.POST(upload(options))).status, 400);
  assert.equal((await kb.POST(upload({ data: '   ' }))).status, 400);
  for (const options of [{ name: 'x.exe' }, { mime: 'application/pdf' }, { data: '%PDF-1.7\n%%EOF' }, { name: 'x.pdf', mime: 'application/pdf', data: 'fake' }, { data: new Uint8Array([255, 0]) }]) assert.equal((await kb.POST(upload(options))).status, 415);
  const duplicate = new FormData(); duplicate.append('name', 'x'); duplicate.append('file', new File(['a'], 'a.txt')); duplicate.append('file', new File(['b'], 'b.txt'));
  assert.equal((await kb.POST(new Request('http://localhost', { method: 'POST', body: duplicate }))).status, 400);
  assert.equal(fetches.length + writes.length, 0);
});
test('file limit is exact; lying/missing Content-Length cannot bypass streamed request cap', async () => {
  assert.equal((await validateFile(new File(['a'.repeat(20_000_000)], 'a.txt', { type: 'text/plain' }))).length, 20_000_000);
  assert.equal((await kb.POST(upload({ data: 'a'.repeat(20_000_001) }))).status, 413);
  for (const headers of [{}, { 'content-length': '1' }]) {
    let count = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) { count++; controller.enqueue(new Uint8Array(1_000_000)); }, cancel() { cancelled = true; } });
    const res = await kb.POST(new Request('http://localhost', { method: 'POST', duplex: 'half', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=test' }, body }));
    assert.equal(res.status, 413); assert.equal(cancelled, true); assert.ok(count <= 23);
  }
  assert.equal(fetches.length, 0);
});
test('database failure compensates object upload and hides internal paths', async () => {
  failDocument = true;
  const res = await kb.POST(upload()); assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'KB_UNAVAILABLE' });
  assert.deepEqual(fetches.map(call => call.options.method), ['PUT', 'DELETE']);
  assert.equal(fetches[0].url, fetches[1].url);
});
test('KB deleted during object upload is rechecked before insert and object is compensated', async () => {
  globalThis.fetch = async (url, options) => { fetches.push({ url, options }); owned = false; return new Response('stored'); };
  assert.equal((await kb.POST(upload({ fields: { kbId: 'kb' } }))).status, 404);
  assert.deepEqual(fetches.map(call => call.options.method), ['PUT', 'DELETE']);
  assert.equal(writes.length, 0);
  assert.ok(!queries.some(query => query.sql.includes('INSERT INTO "Document"')));
});
test('uncertain storage failure attempts compensation without inserting documents', async () => {
  globalThis.fetch = async (url, options) => { fetches.push({ url, options }); return new Response('', { status: 500 }); };
  assert.equal((await kb.POST(upload())).status, 503);
  assert.deepEqual(fetches.map(call => call.options.method), ['PUT', 'DELETE']);
  assert.equal(writes.length, 0);
});
test('mount GET/PUT ownership, deduplication, replacement and empty unmount', async () => {
  assert.deepEqual(await (await mount.GET(req(), context('conv'))).json(), { kbIds: ['old'] });
  assert.deepEqual(await (await mount.PUT(json(['kb', 'kb']), context('conv'))).json(), { kbIds: ['kb'] });
  assert.deepEqual(mounts, ['kb']);
  assert.match(queries.find(query => query.sql.includes('FROM "Conversation"')).sql, /FOR UPDATE/);
  assert.equal((await mount.PUT(json([]), context('conv'))).status, 200); assert.deepEqual(mounts, []);
  owned = false; assert.equal((await mount.GET(req(), context('foreign'))).status, 404);
  assert.equal((await mount.PUT(json([]), context('foreign'))).status, 404);
});
test('mount validates all KB owners before writes and preserves prior mounts on rejection', async () => {
  assert.equal((await mount.PUT(json(['kb', 'foreign']), context('conv'))).status, 404);
  assert.deepEqual(mounts, ['old']); assert.equal(writes.length, 0);
  for (const value of [null, 'x', [1], [''], [{}]]) assert.equal((await mount.PUT(json(value), context('conv'))).status, 400);
});
test('mount transaction rolls back replacement when an insert fails (mock transaction)', async () => {
  const execute = f.prisma.$executeRaw;
  f.prisma.$executeRaw = async (strings, ...values) => {
    if (strings.join('?').includes('INSERT INTO')) throw new Error('/private/db');
    return execute(strings, ...values);
  };
  const res = await mount.PUT(json(['kb']), context('conv'));
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'KB_UNAVAILABLE' });
  assert.deepEqual(mounts, ['old']);
});
test('MinIO get/remove/list wrap SDK bucket and prefix and sanitize configuration errors', async () => {
  const chunks = []; for await (const part of await storage.get('user/kb/doc')) chunks.push(part);
  assert.equal(Buffer.concat(chunks).toString(), 'stored');
  await storage.remove('user/kb/doc');
  const listed = []; for await (const item of storage.list('user/')) listed.push(item);
  assert.equal(listed[0].key, 'user/doc'); assert.deepEqual(f.listArgs, { bucket: 'private', prefix: 'user/', recursive: true });
  process.env.S3_ENDPOINT = 'file:///private/path';
  await assert.rejects(storage.put('x', Buffer.from('x'), 'text/plain'), { message: 'STORAGE_UNAVAILABLE' });
});
