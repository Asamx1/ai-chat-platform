// Dev orchestrator: run web and worker dev servers together.
// No new deps — plain node child_process. Prefixes output, forwards SIGINT,
// and kills the sibling when either child exits.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

function run(name, cmd, args) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin, // pnpm.cmd on Windows needs a shell
    env: process.env,
  });

  const pipe = (stream, prefix) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
    });
  };
  pipe(child.stdout, name);
  pipe(child.stderr, name);

  child.on('exit', (code, signal) => {
    process.stderr.write(`[${name}] exited (code=${code} signal=${signal})\n`);
    killAll();
    if (!exited) {
      exited = true;
      process.exit(code ?? 1);
    }
  });
  return child;
}

const children = [];
let exited = false;

function killAll() {
  for (const c of children) {
    if (!c.killed) c.kill();
  }
}

children.push(run('web', 'pnpm', ['--filter', '@aichat/web', 'dev']));
children.push(run('worker', 'pnpm', ['--filter', '@aichat/worker', 'dev']));

process.on('SIGINT', () => {
  killAll();
});
process.on('SIGTERM', () => {
  killAll();
});
