import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '@aichat/db';
import { reextractAll } from '../src/extract.js';
import { database } from '../src/scan.js';

const { values } = parseArgs({ options: {
  vault: { type: 'string', default: '/mnt/d/wiki-vault' },
  'vault-id': { type: 'string', default: 'default' }, 'user-id': { type: 'string' },
  'only-missing': { type: 'boolean', default: false },
  'min-assertions': { type: 'string', default: '8' },
} });
let db: PrismaClient | undefined;
try {
  const minAssertions = Number(values['min-assertions']);
  if (!/^\d+$/u.test(values['min-assertions']) || !Number.isSafeInteger(minAssertions))
    throw new Error('--min-assertions must be a non-negative integer');
  db = await database();
  const userId = values['user-id'] ?? process.env.AICHAT_USER_ID;
  const reports = await reextractAll(values['vault-id'], db, { vaultPath: values.vault,
    onlyMissing: values['only-missing'], minAssertions,
    ...(userId ? { userId } : {}), onSource: report => process.stdout.write(`${JSON.stringify(report)}\n`) });
  process.stdout.write(`${JSON.stringify({ sources: reports.length, failed: reports.filter(r => r.error).length,
    oldAssertions: reports.reduce((n, r) => n + r.oldCount, 0), newAssertions: reports.reduce((n, r) => n + r.newCount, 0) })}\n`);
  if (reports.some(r => r.error)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  process.stdout.write('重抽未自动发布；请检查逐来源报告，修复失败项后手动 publish。\n');
  await db?.$disconnect();
}
