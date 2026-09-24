import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '@aichat/db';
import { database } from '../src/scan';
import { lintVault } from '../src/lint';
const { values } = parseArgs({ options: {
  vault: { type: 'string', default: '/mnt/d/wiki-vault' }, 'vault-id': { type: 'string', default: 'default' },
} });
let db: PrismaClient | undefined;
try {
  db = await database();
  const report = await lintVault(values.vault, values['vault-id'], db);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.issues.length) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error) })}\n`); process.exitCode = 1;
} finally { await db?.$disconnect(); }
