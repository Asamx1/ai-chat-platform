// Lint currently means TypeScript checking only; no style linter is configured.
import { readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'apps/web/package.json'));
let tsc;
try { tsc = require.resolve('typescript/bin/tsc'); }
catch { console.error('TypeScript unavailable: existing apps/web dependencies are required.'); process.exit(1); }
let exitCode = 0;
for (const parent of ['apps', 'packages']) {
  for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const config = path.join(root, parent, entry.name, 'tsconfig.json');
    if (!existsSync(config)) continue;
    console.log(`Typecheck ${path.relative(root, config)}`);
    const result = spawnSync(process.execPath, [tsc, '-p', config, '--noEmit', '--incremental', 'false'], { cwd: root, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0 && exitCode === 0) exitCode = result.status ?? 1;
  }
}
process.exitCode = exitCode;
