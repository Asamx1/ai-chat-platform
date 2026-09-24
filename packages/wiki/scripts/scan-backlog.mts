import 'dotenv/config';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Prisma, PrismaClient } from '@aichat/db';
import { database, scanRawDir } from '../src/scan.js';
import { ingestFile } from '../src/ingest.js';
import { ingestMultimodal } from '../src/multimodal.js';
import { claimNextJob, completeJob, enqueueJob, failJob } from '../src/jobs.js';

const { values } = parseArgs({ options: {
  vault: { type: 'string', default: '/mnt/d/wiki-vault' },
  'vault-id': { type: 'string', default: 'default' }, 'user-id': { type: 'string' },
} });
let db: PrismaClient | undefined;
try {
  db = await database();
  const vaultId = values['vault-id'];
  const vaultPath = resolve(values.vault);
  // Sources registered by the old OCR placeholder still need extraction.
  const known = new Set((await db.vaultSource.findMany({ where: { vaultId,
    OR: [{ evidence: { some: { vaultId } } }, { entityCandidates: { some: { vaultId } } }] },
    select: { sha256: true } })).map(s => s.sha256));
  let enqueued = 0; let registered = 0; let extracted = 0; let failed = 0; let needsOcr = 0;
  for (const file of await scanRawDir(vaultPath)) {
    if (known.has(file.sha256)) continue;
    await enqueueJob('scan_backlog', { vaultPath, filePath: file.filePath, sha256: file.sha256, parserVersion: 'multimodal-v1' }, vaultId, db);
    known.add(file.sha256); enqueued++;
  }
  // Drain ready jobs, including retries from previous invocations. Backoff jobs remain pending.
  // Use a fixed cutoff so a failure cannot consume all retry attempts in one invocation.
  const now = new Date();
  const userId = values['user-id'] ?? process.env.AICHAT_USER_ID;
  for (;;) {
    const job = await claimNextJob(vaultId, db, { kind: 'scan_backlog', now });
    if (!job) break;
    try {
      const payload = job.payload as Record<string, unknown>;
      if (payload.vaultPath !== vaultPath || typeof payload.filePath !== 'string' || typeof payload.sha256 !== 'string') throw new Error('INVALID_BACKLOG_PAYLOAD');
      let report = await ingestFile(vaultPath, payload.filePath, { db, vaultId, resumeRegistered: true,
        expectedSha256: payload.sha256, ...(userId ? { userId } : {}) });
      if (report.sourceId && !report.isDuplicate) registered++;
      if (report.needsOcr) report = await ingestMultimodal(vaultPath, payload.filePath, { db, vaultId, resumeRegistered: true,
        expectedSha256: payload.sha256, ...(userId ? { userId } : {}) });
      if (report.needsOcr) needsOcr++;
      // Preserve quality limitations in the job result, without retrying them as successful extraction.
      if (report.qualityInsufficient) {
        await completeJob(job, JSON.parse(JSON.stringify(report)) as Prisma.InputJsonObject, db);
        continue;
      }
      if (report.errors.length || report.state === 'failed') throw new Error(JSON.stringify(report.errors));
      if (report.state === 'ingested') extracted++;
      await completeJob(job, JSON.parse(JSON.stringify(report)) as Prisma.InputJsonObject, db);
    } catch (error) { failed++; await failJob(job, error, db); }
  }
  process.stdout.write(`${JSON.stringify({ enqueued, registered, extracted, failed, needsOcr })}\n`);
  if (failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${String(error)}\n`); process.exitCode = 1;
} finally { await db?.$disconnect(); }
