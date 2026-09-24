import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(desktop, '../..');
function run(command, args, cwd) {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'cmd.exe' : command,
    windows ? ['/d', '/s', '/c', [command + '.cmd', ...args].join(' ')] : args,
    { cwd, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
run('pnpm', ['--filter', '@aichat/web', 'build'], repo);
run('npx', ['--no-install', 'tsc', '-p', 'tsconfig.json'], desktop);
run('npx', ['--no-install', 'electron-builder', '--config', 'electron-builder.yml', '--win', 'nsis'], desktop);
