import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ServiceManager, webEnvironment, type Health } from '../src/services/service-manager';
import { acquireSingleInstance } from '../src/single-instance';

test('probe reports closed ports down and emits Docker guidance', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const manager = new ServiceManager({ repoRoot: '/repo', userData: tmpdir(), env: {},
    ports: { postgres: port, minio: port, web: port }, timeoutMs: 100 });
  let missing: Health[] = [];
  manager.on('docker-dependency-down', items => { missing = items; });
  assert.deepEqual((await manager.probe()).map(item => item.state), ['down', 'down', 'down']);
  assert.deepEqual(missing.map(item => item.name), ['postgres', 'minio']);
  await manager.stopAll();
});

test('environment rewrites host/port while preserving database credentials and options', () => {
  const input = { DATABASE_URL: 'postgresql://alice:s%40fe@localhost:5432/wiki?sslmode=disable', KEEP: 'yes' };
  const output = webEnvironment(input);
  const url = new URL(output.DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '5433');
  assert.equal(url.password, 's%40fe');
  assert.equal(url.pathname, '/wiki');
  assert.equal(url.searchParams.get('sslmode'), 'disable');
  assert.equal(output.KEEP, 'yes');
  assert.equal(output.BETTER_AUTH_URL, 'http://localhost:3001');
  assert.equal(input.DATABASE_URL.includes('localhost:5432'), true);
});

test('startWeb passes overridden env and cwd to fake spawn; spawn failure rejects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-service-test-'));
  let launchOptions: SpawnOptions | undefined;
  let launches = 0;
  class ReadyDependencies extends ServiceManager {
    override async probe(): Promise<Health[]> {
      return [
        { name: 'postgres', state: 'up', detail: 'fake' },
        { name: 'minio', state: 'up', detail: 'fake' },
        { name: 'web', state: 'down', detail: 'fake' },
      ];
    }
  }
  const manager = new ReadyDependencies({ repoRoot: directory, userData: directory,
    env: { DATABASE_URL: 'postgresql://user:password@localhost:5432/wiki' },
    ports: { postgres: 5433, minio: 9000, web: 0 },
    timeoutMs: 30, pollMs: 1, readyTimeoutMs: 200,
    spawn: (_command, args, options) => {
      launches++;
      launchOptions = options;
      assert.match(args.join(' '), /next start -p 3001/);
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('fake launch failure')));
      return child;
    },
  });
  try {
    const starting = manager.startWeb();
    assert.equal(manager.startWeb(), starting);
    await assert.rejects(starting, /Web/);
    assert.equal(launches, 1);
    assert.equal(launchOptions?.cwd, join(directory, 'apps', 'web'));
    assert.equal(new URL(launchOptions?.env?.DATABASE_URL as string).port, '5433');
    assert.equal(launchOptions?.env?.BETTER_AUTH_URL, 'http://localhost:3001');
  } finally {
    await manager.stopAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('single-instance loser quits; owner continues', () => {
  let quits = 0;
  assert.equal(acquireSingleInstance({ requestSingleInstanceLock: () => false, quit: () => { quits++; } }), false);
  assert.equal(quits, 1);
  assert.equal(acquireSingleInstance({ requestSingleInstanceLock: () => true, quit: () => { quits++; } }), true);
  assert.equal(quits, 1);
});
