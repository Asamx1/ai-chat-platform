import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ingestFile, ingestVault } from '../src/ingest.js';
import { database } from '../src/scan.js';
import type { PrismaClient } from '@aichat/db';

const { values } = parseArgs({ options: {
  vault: { type: 'string', default: '/mnt/d/wiki-vault' }, file: { type: 'string' },
  'vault-id': { type: 'string', default: 'default' }, out: { type: 'string' }, 'user-id': { type: 'string' },
} });
const userId = values['user-id'] ?? process.env.AICHAT_USER_ID;
let db: PrismaClient | undefined;
try {
  db = await database();
  const opts = { db, vaultId: values['vault-id'], ...(userId ? { userId } : {}) };
  const reports = values.file ? [await ingestFile(values.vault, values.file, opts)] : await ingestVault(values.vault, opts);
  const json = `${JSON.stringify(reports, null, 2)}\n`;
  const date = new Date().toISOString().replaceAll(':', '-');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const out = resolve(values.out ?? process.env.INGEST_REPORT_OUT ?? resolve(root, `docs/eval/ingest-report-${date}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json, 'utf8');
  process.stdout.write(json);
  if (reports.some(report => report.errors.length)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
