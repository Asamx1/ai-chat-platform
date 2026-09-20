import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const harness = new URL('./deepseek-fixture.mjs', import.meta.url).href;
const setup = new URL('../../worker/test/setup.ts', import.meta.url).href;
const seed = new URL('../scripts/seed.ts', import.meta.url).href;
function child(code, env) {
  const inherited = { ...process.env };
  delete inherited.NODE_TEST_CONTEXT;
  delete inherited.AICHAT_TEST_DB_URL;
  delete inherited.SEED_ADMIN_PASSWORD;
  const dir = mkdtempSync(join(tmpdir(), 'deepseek-safety-'));
  const stdout = join(dir, 'stdout');
  const stderr = join(dir, 'stderr');
  const out = openSync(stdout, 'w');
  const err = openSync(stderr, 'w');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...inherited, ...env }, stdio: ['ignore', out, err],
    });
    assert.ifError(result.error);
    return { ...result, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') };
  } finally {
    closeSync(out); closeSync(err); rmSync(dir, { recursive: true, force: true });
  }
}
for (const [name, env] of [
  ['production environment', { NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/app_test' }],
  ['main database', { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/app' }],
  ['test marker in credentials only', { NODE_ENV: 'test', DATABASE_URL: 'postgres://user_test:password@localhost/app' }],
]) {
  test(`B3 rejects ${name} before queue access`, () => {
    const result = child(`
      import { fixture } from ${JSON.stringify(harness)};
      fixture.prisma.orchestrationRun = { updateMany: async () => { console.log('QUEUE_TOUCHED'); } };
      await import(${JSON.stringify(setup)});
    `, env);
    assert.equal(result.status, 1); assert.match(result.stderr, /Worker tests require/);
    assert.doesNotMatch(result.stdout, /QUEUE_TOUCHED/);
  });
}
test('B3 uses the explicit test database and limits cleanup to test-prefixed runs', () => {
  const result = child(`
    import { fixture } from ${JSON.stringify(harness)};
    fixture.prisma.orchestrationRun = { updateMany: async (args) => console.log(JSON.stringify({ args, url: process.env.DATABASE_URL })) };
    await import(${JSON.stringify(setup)});
  `, { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/main', AICHAT_TEST_DB_URL: 'postgres://localhost/isolated_test' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.url, 'postgres://localhost/isolated_test');
  assert.deepEqual(output.args.where.idempotencyKey, { startsWith: 'test-' });
});
test('B2 production without password exits 1 before database writes', () => {
  const result = child(`
    import { fixture } from ${JSON.stringify(harness)};
    fixture.prisma.user = { upsert: async () => { console.log('USER_WRITTEN'); } };
    await import(${JSON.stringify(seed)});
  `, { NODE_ENV: 'production' });
  assert.equal(result.status, 1); assert.match(result.stderr, /SEED_ADMIN_PASSWORD is required/);
  assert.doesNotMatch(result.stdout, /USER_WRITTEN/);
});
test('seed registers both DeepSeek models and a local default; production skips demo user', () => {
  const result = child(`
    import { fixture } from ${JSON.stringify(harness)};
    const calls = { users: [], providers: [], models: [] };
    Object.assign(fixture.prisma, {
      user: { upsert: async (args) => { calls.users.push(args); return { id: 'admin' }; } },
      account: { upsert: async () => {} },
      provider: { upsert: async (args) => calls.providers.push(args) },
      modelRegistry: { upsert: async (args) => calls.models.push(args) },
      $disconnect: async () => console.log('RESULT:' + JSON.stringify(calls)),
    });
    await import(${JSON.stringify(seed)});
  `, { NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'explicit-test-password' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.split('RESULT:')[1]);
  assert.equal(output.users.length, 1);
  assert.deepEqual(output.models.map(m => m.create.modelKey), ['deepseek-chat', 'deepseek-reasoner', 'qwen3:0.6b']);
  assert.equal(output.models[2].create.isDefault, true);
  assert.equal(output.providers[0].create.baseUrl, 'https://api.deepseek.com/v1');
});
