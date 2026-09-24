import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { get } from 'node:http';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export type Health = { name: 'postgres' | 'minio' | 'web'; state: 'up' | 'down'; detail: string };
type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type Options = {
  repoRoot: string; userData: string; env?: NodeJS.ProcessEnv; spawn?: Spawn;
  timeoutMs?: number; readyTimeoutMs?: number; pollMs?: number; stopTimeoutMs?: number;
  ports?: { postgres: number; minio: number; web: number };
};

export function webEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const url = new URL(env.DATABASE_URL || `postgresql://${encodeURIComponent(env.POSTGRES_USER || 'aichat')}:${encodeURIComponent(env.POSTGRES_PASSWORD || '')}@127.0.0.1/aichat`);
  url.hostname = '127.0.0.1';
  url.port = '5433';
  if (!env.DATABASE_URL) url.pathname = '/' + (env.POSTGRES_DB || 'aichat');
  return { ...env, DATABASE_URL: url.toString(), BETTER_AUTH_URL: 'http://localhost:3001',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3001', PORT: '3001', NODE_ENV: 'production' };
}

export function tcpProbe(port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(timeout, () => finish(new Error('TCP timeout')));
    socket.once('error', finish);
    socket.once('connect', () => finish());
  });
}

export function httpProbe(port: number, path: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path }, response => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error(`HTTP ${response.statusCode}`));
    });
    const timer = setTimeout(() => request.destroy(new Error('HTTP timeout')), timeout);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
  });
}

export class ServiceManager extends EventEmitter {
  private child?: ChildProcess;
  private log?: WriteStream;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private health: Health[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly launch: Spawn;
  private readonly ports;
  private readonly timeout: number;
  constructor(private readonly options: Options) {
    super();
    this.env = webEnvironment(options.env || process.env);
    this.launch = options.spawn || spawn;
    this.ports = options.ports || { postgres: 5433, minio: 9000, web: 3001 };
    this.timeout = options.timeoutMs ?? 1500;
  }
  getState() { return { health: this.health, starting: !!this.starting, ownedWeb: !!this.child }; }

  async probe(): Promise<Health[]> {
    const check = async (name: Health['name'], action: () => Promise<void>): Promise<Health> => {
      try { await action(); return { name, state: 'up', detail: '健康检查通过' }; }
      catch { return { name, state: 'down', detail: name === 'postgres'
        ? `127.0.0.1:${this.ports.postgres} TCP / SELECT 1 失败；检查容器、端口和数据库凭据`
        : `127.0.0.1:${this.ports[name]} 健康检查失败` }; }
    };
    this.health = await Promise.all([
      check('postgres', async () => {
        await tcpProbe(this.ports.postgres, this.timeout);
        const connectionURL = new URL(this.env.DATABASE_URL!);
        connectionURL.port = String(this.ports.postgres);
        const client = new Client({ connectionString: connectionURL.toString(),
          connectionTimeoutMillis: this.timeout, query_timeout: this.timeout });
        try { await client.connect(); await client.query('SELECT 1'); }
        finally { await client.end().catch(() => undefined); }
      }),
      check('minio', () => httpProbe(this.ports.minio, '/minio/health/live', this.timeout)),
      check('web', () => httpProbe(this.ports.web, '/login', this.timeout)),
    ]);
    const missing = this.health.filter(item => item.name !== 'web' && item.state === 'down');
    if (missing.length) this.emit('docker-dependency-down', missing);
    return this.health;
  }

  startWeb(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('桌面宿主正在退出'));
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async start(): Promise<void> {
    const health = await this.probe();
    if (this.closed) throw new Error('启动已取消');
    if (health.some(item => item.name !== 'web' && item.state === 'down')) {
      throw new Error('请先启动 PostgreSQL / MinIO Docker 依赖，再重试。');
    }
    if (health.some(item => item.name === 'web' && item.state === 'up')) return;
    if (this.child) await this.stopChild();
    if (this.closed) throw new Error('启动已取消');
    mkdirSync(join(this.options.userData, 'logs'), { recursive: true });
    this.log = createWriteStream(join(this.options.userData, 'logs', 'web.log'), { flags: 'a' });
    let failed = false;
    this.log.on('error', () => { failed = true; });
    try {
      // Windows needs cmd.exe to invoke npx.cmd. Arguments are fixed, never renderer input.
      const windows = process.platform === 'win32';
      const child = this.launch(windows ? 'cmd.exe' : 'npx', windows
        ? ['/d', '/s', '/c', 'npx.cmd --no-install next start -p 3001']
        : ['--no-install', 'next', 'start', '-p', '3001'], {
        cwd: join(this.options.repoRoot, 'apps', 'web'), env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true,
      });
      this.child = child;
      child.stdout?.pipe(this.log, { end: false });
      child.stderr?.pipe(this.log, { end: false });
      child.once('error', () => { failed = true; });
      child.once('exit', () => { failed = true; });
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60000);
      while (Date.now() < deadline && !this.closed) {
        if (failed) throw new Error('Web 进程或日志失败，请检查 logs/web.log');
        try {
          await httpProbe(this.ports.web, '/login', this.timeout);
          if (!failed && !this.closed) return;
        } catch { /* wait until readiness deadline */ }
        await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 400));
      }
      throw new Error(this.closed ? '启动已取消' : 'Web 就绪超时，请检查 logs/web.log');
    } catch (error) { await this.stopChild(); throw error; }
  }

  stopAll(): Promise<void> {
    this.closed = true;
    return this.stopping ||= (async () => {
      await this.starting?.catch(() => undefined);
      await this.stopChild();
    })();
  }
  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child?.pid) {
      const pid = child.pid;
      const signal = (force: boolean): Promise<void> => {
        if (process.platform === 'win32') return new Promise((resolve, reject) => {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true });
          killer.once('error', reject);
          killer.once('exit', code => code === 0 || code === 128 ? resolve() : reject(new Error('taskkill failed')));
        });
        try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error); }
        return Promise.resolve();
      };
      try { await signal(false); }
      finally {
        // Keep the group grace period even if the npx parent exits before Next.js.
        await new Promise(resolve => setTimeout(resolve, this.options.stopTimeoutMs ?? 5000));
        await signal(true);
      }
    }
    const log = this.log;
    this.log = undefined;
    if (log && !log.destroyed) await new Promise<void>(resolve => log.end(resolve));
  }
}
