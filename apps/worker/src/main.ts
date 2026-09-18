import os from 'node:os';
import { claimNextRun } from './lease';
import { processRun } from './runner';

const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}:${process.pid}`;
const WORKER_ONCE = process.env.WORKER_ONCE === '1';
const POLL_INTERVAL_MS = 1_000;

let shuttingDown = false;

process.on('SIGINT', () => {
  // 优雅退出：不打断当前 run，处理完再退。
  shuttingDown = true;
});

async function main(): Promise<void> {
  while (!shuttingDown) {
    const runId = await claimNextRun(WORKER_ID);
    if (runId) {
      await processRun(runId, WORKER_ID);
      if (WORKER_ONCE) break;
      continue;
    }
    if (WORKER_ONCE) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
