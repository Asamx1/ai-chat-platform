import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { database } from '../src/scan.js';
import { inferAssertions, persistInferred } from '../src/infer.js';

const { values } = parseArgs({ options: {
  'vault-id': { type: 'string', default: 'default' },
  'dry-run': { type: 'boolean', default: false },
} });

const db = await database();
try {
  const vaultId = values['vault-id']!;
  const inferred = await inferAssertions(vaultId, db);
  const byRule = new Map<string, number>();
  for (const a of inferred) byRule.set(a.ruleVersion, (byRule.get(a.ruleVersion) ?? 0) + 1);
  console.log(JSON.stringify({ vaultId, inferredCount: inferred.length, byRuleVersion: [...byRule], dryRun: values['dry-run'] }, null, 2));
  if (!values['dry-run']) {
    const { created, updated } = await persistInferred(vaultId, db, inferred);
    console.log(JSON.stringify({ persisted: { created, updated } }));
  }
} finally {
  await db.$disconnect();
}
