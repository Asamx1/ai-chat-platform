import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rag-ablation-run.ts'], {
  cwd: root, stdio: 'inherit', env: process.env,
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
