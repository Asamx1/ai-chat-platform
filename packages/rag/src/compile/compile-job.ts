import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import { SUMMARY_PROMPT_VERSION, SUMMARY_SCHEMA_VERSION } from './summary';

const configHash = createHash('sha256').update(`deepseek-chat:${SUMMARY_PROMPT_VERSION}:${SUMMARY_SCHEMA_VERSION}`).digest('hex');
export type CompileJobRow = { id: string; kbId: string; sourceVersionId: string; generationId: string; artifactType: string; attempt: number; maxAttempts: number; leaseOwner: string; documentId: string; userId: string };
export const summaryIdempotencyKey = (version: string, generation: string) =>
  createHash('sha256').update(`${version}:${generation}:SUMMARY:${configHash}`).digest('hex');

export async function consumeCompileOutbox(): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const [event] = await tx.$queryRawUnsafe<{ id: string; kbId: string; documentId: string; sourceVersionId: string; generationId: string }[]>(
      `SELECT * FROM "CompileOutbox" WHERE "processedAt" IS NULL ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!event) return false;
    await tx.$executeRawUnsafe(`INSERT INTO "CompileJob" (id,"kbId","sourceVersionId","generationId","artifactType",model,"promptVersion","schemaVersion",status,attempt,"maxAttempts","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'SUMMARY','deepseek-chat',$5,$6,'PENDING',0,2,$7,clock_timestamp(),clock_timestamp()) ON CONFLICT ("idempotencyKey") DO NOTHING`,
    randomUUID(), event.kbId, event.sourceVersionId, event.generationId, SUMMARY_PROMPT_VERSION, SUMMARY_SCHEMA_VERSION,
    summaryIdempotencyKey(event.sourceVersionId, event.generationId));
    await tx.$executeRawUnsafe(`UPDATE "CompileOutbox" SET "processedAt"=clock_timestamp() WHERE id=$1`, event.id);
    return true;
  });
}

export async function claimCompileJob(owner: string): Promise<CompileJobRow | null> {
  const [row] = await prisma.$queryRawUnsafe<CompileJobRow[]>(`UPDATE "CompileJob" j SET status='RUNNING',attempt=j.attempt+1,
    "leaseOwner"=$1,"leaseExpiresAt"=clock_timestamp()+interval '90 seconds',"lastError"=NULL,"updatedAt"=clock_timestamp()
    WHERE j.id=(SELECT id FROM "CompileJob" WHERE attempt<"maxAttempts" AND "artifactType"='SUMMARY'
      AND EXISTS (SELECT 1 FROM "IndexGeneration" g WHERE g.id="CompileJob"."generationId" AND g.status<>'FAILED') AND
      ((status='PENDING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=clock_timestamp())) OR
       (status='RUNNING' AND "leaseExpiresAt"<=clock_timestamp())))
      ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING j.id,j."kbId",j."sourceVersionId",j."generationId",j."artifactType",j.attempt,j."maxAttempts",j."leaseOwner",
      (SELECT "documentId" FROM "SourceVersion" WHERE id=j."sourceVersionId") AS "documentId",
      (SELECT "userId" FROM "KnowledgeBase" WHERE id=j."kbId") AS "userId"`, owner);
  return row ?? null;
}

export async function renewCompileJob(job: CompileJobRow): Promise<boolean> {
  return (await prisma.$executeRawUnsafe(`UPDATE "CompileJob" SET "leaseExpiresAt"=clock_timestamp()+interval '90 seconds'
    WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp()`,
    job.id, job.attempt, job.leaseOwner)) === 1;
}

export async function failCompileJob(job: CompileJobRow, error: unknown): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "CompileJob" SET status=CASE WHEN attempt<"maxAttempts" THEN 'PENDING' ELSE 'FAILED' END,
    "lastError"=$4,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
    WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp()`,
    job.id, job.attempt, job.leaseOwner, String(error).slice(0, 1000));
}

export async function pauseForBudget(job: CompileJobRow): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "CompileJob" SET status='PENDING',attempt=attempt-1,"lastError"='budget_exhausted',
    "leaseOwner"=NULL,"leaseExpiresAt"=clock_timestamp()+interval '60 seconds',"updatedAt"=clock_timestamp()
    WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp()`,
    job.id, job.attempt, job.leaseOwner);
}
