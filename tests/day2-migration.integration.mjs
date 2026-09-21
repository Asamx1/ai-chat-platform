// Explicit disposable PostgreSQL check; all fixture DDL/data is rolled back.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL database');
const migration = readFileSync(new URL('../packages/db/prisma/migrations/20260921020000_admin_quota/migration.sql', import.meta.url), 'utf8').replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '');
async function fixture(run) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const schema = 'day2_' + randomUUID().replaceAll('-', '');
    await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE "User" (id text PRIMARY KEY);
      CREATE TABLE "ModelRegistry" (id text PRIMARY KEY,"modelKey" text,"providerId" text);
      CREATE TABLE "ModelUsageDaily" (id text PRIMARY KEY,"userId" text,"modelId" text,date date,"tokensIn" integer DEFAULT 0,"tokensOut" integer DEFAULT 0,UNIQUE("userId","modelId",date));
      CREATE TABLE "ProviderCall" (id text PRIMARY KEY,"participantSnapshotId" text,"startedAt" timestamp);
      CREATE TABLE "UsageLog" ("userId" text,"callId" text);
      CREATE TABLE "RunParticipantSnapshot" (id text PRIMARY KEY,"modelKey" text,"providerKey" text);
      INSERT INTO "User" VALUES ('u');
      INSERT INTO "ModelRegistry" VALUES ('m','legacy','p');
      INSERT INTO "ModelUsageDaily" VALUES ('old','u','legacy','2026-09-21',10,2),('new','u','m','2026-09-21',20,3);
    `);
    await run(client);
  } finally { await client.query('ROLLBACK'); await client.end(); }
}
test('migration merges legacy and normalized usage without losing tokens', async () => {
  await fixture(async client => {
    await client.query(migration);
    const { rows } = await client.query('SELECT "modelId","tokensIn","tokensOut","reservedTokens" FROM "ModelUsageDaily"');
    assert.deepEqual(rows, [{ modelId:'m', tokensIn:30, tokensOut:5, reservedTokens:0 }]);
    await assert.rejects(client.query('INSERT INTO "UserModelQuota" VALUES ($1,$2,$3,$4)', ['q','u','m',-1]), /check constraint/);
  });
});
test('ambiguous provider/modelKey mappings stop migration', async () => {
  await fixture(async client => {
    await client.query(`INSERT INTO "ModelRegistry" VALUES ('other','legacy','other-provider')`);
    await assert.rejects(client.query(migration), /unmapped or ambiguous/);
  });
});
test('provider evidence resolves a repeated modelKey', async () => {
  await fixture(async client => {
    await client.query(`INSERT INTO "ModelRegistry" VALUES ('other','legacy','other-provider');
      INSERT INTO "RunParticipantSnapshot" VALUES ('s','legacy','p');
      INSERT INTO "ProviderCall" VALUES ('c','s','2026-09-21 12:00:00');
      INSERT INTO "UsageLog" VALUES ('u','c')`);
    await client.query(migration);
    const { rows } = await client.query('SELECT "modelId","tokensIn" FROM "ModelUsageDaily"');
    assert.deepEqual(rows,[{modelId:'m',tokensIn:30}]);
  });
});
