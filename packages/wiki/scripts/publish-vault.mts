import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '@aichat/db';
import { database } from '../src/scan.js';
import { eligiblePromotions } from '../src/promote.js';
import { publishRevision } from '../src/publish.js';

const { values } = parseArgs({ options: {
  vault: { type: 'string', default: '/mnt/d/wiki-vault' },
  'vault-id': { type: 'string', default: 'default' },
  'user-id': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
} });
let db: PrismaClient | undefined;
try {
  db = await database();
  const userId = values['user-id'] ?? process.env.AICHAT_USER_ID;
  const report = values['dry-run']
    ? { dryRun: true, eligible: await eligiblePromotions(values['vault-id'], db) }
    : await publishRevision(values.vault, values['vault-id'], db, { ...(userId ? { userId } : {}) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
