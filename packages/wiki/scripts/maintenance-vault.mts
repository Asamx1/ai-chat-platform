import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '@aichat/db';
import { database } from '../src/scan';
import { propagateRetraction, recomputeInferences, markVersionStaleness, demoteLonelyConcepts } from '../src/maintenance';

let db: PrismaClient | undefined;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    vault: { type: 'string', default: '/mnt/d/wiki-vault' }, 'vault-id': { type: 'string', default: 'default' },
    'assertion-id': { type: 'string' },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['recompute-inferences', 'retract', 'staleness', 'demote'].includes(command ?? '')) throw new Error('Expected recompute-inferences | retract --assertion-id ID | staleness | demote');
  if (command === 'retract' && !values['assertion-id']) throw new Error('--assertion-id is required');
  db = await database();
  const vaultId = values['vault-id'];
  if (command === 'retract') await db.vaultAssertion.findFirstOrThrow({ where: { id: values['assertion-id']!, vaultId } });
  const result = command === 'retract' ? await propagateRetraction(values['assertion-id']!, db, { vaultPath: values.vault })
    : command === 'recompute-inferences' ? await recomputeInferences(vaultId, db, { vaultPath: values.vault })
    : command === 'staleness' ? await markVersionStaleness(vaultId, db) : await demoteLonelyConcepts(vaultId, db);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: String(error) })}\n`); process.exitCode = 1;
} finally { await db?.$disconnect(); }
