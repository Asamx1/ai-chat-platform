import { randomUUID } from 'node:crypto';
import * as minio from 'minio';
import { prisma } from '@aichat/db';
import { claimCompileJob, consumeCompileOutbox, compileSummary, failCompileJob, pauseForBudget, renewCompileJob, type CompileJobRow, type SourceChunk } from '@aichat/rag/compile';
import { embed, embeddingModel } from '@aichat/rag';

const reservationUsd = 0.05;
function storage(): { client: minio.Client; bucket: string } {
  const { S3_ENDPOINT, S3_BUCKET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) throw new Error('STORAGE_UNAVAILABLE');
  const url = new URL(S3_ENDPOINT);
  return { bucket: S3_BUCKET, client: new minio.Client({ endPoint: url.hostname, port: Number(url.port || 9000),
    useSSL: url.protocol === 'https:', accessKey: MINIO_ROOT_USER, secretKey: MINIO_ROOT_PASSWORD }) };
}

export async function reserveCompileBudget(job: CompileJobRow): Promise<boolean> {
  const configured = Number(process.env.RAG_COMPILE_BUDGET_CNY ?? '5');
  if (!Number.isFinite(configured) || configured < 0) throw new Error('INVALID_COMPILE_BUDGET');
  return prisma.$transaction(async tx => {
    const locked = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "KnowledgeBase" WHERE id=$1 FOR UPDATE`, job.kbId);
    if (!locked.length) throw new Error('KB_NOT_FOUND');
    const [used] = await tx.$queryRawUnsafe<{ total: number }[]>(`SELECT COALESCE(sum(COALESCE("costUsd",$2::numeric)),0)::float AS total
      FROM "CompileCostLedger" WHERE "kbId"=$1 AND "createdAt">=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')
      AND status IN ('RESERVED','SUCCEEDED','UNKNOWN_COST','FAILED')`, job.kbId, reservationUsd);
    if ((used?.total ?? 0) + reservationUsd > configured / 7.2) return false;
    await tx.$executeRawUnsafe(`INSERT INTO "CompileCostLedger" (id,"kbId","compileJobId",model,operation,"priceVersion",attempt,status,"requestDedupKey")
      VALUES ($1,$2,$3,'deepseek-chat','SUMMARY','estimate-v1',$4,'RESERVED',$5) ON CONFLICT ("requestDedupKey") DO NOTHING`,
      randomUUID(), job.kbId, job.id, job.attempt, `${job.id}:${job.attempt}`);
    return true;
  });
}

export async function processCompileJob(job: CompileJobRow): Promise<void> {
  const controller = new AbortController();
  const heartbeat = setInterval(() => { void renewCompileJob(job).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 20_000);
  let called = false;
  const started = Date.now();
  try {
    const [existing] = await prisma.$queryRawUnsafe<{ artifactDocumentId: string | null }[]>(`SELECT "artifactDocumentId" FROM "CompileJob" WHERE id=$1`, job.id);
    if (existing?.artifactDocumentId) {
      await prisma.$executeRawUnsafe(`UPDATE "CompileJob" SET status='SUCCEEDED',"leaseOwner"=NULL,"leaseExpiresAt"=NULL WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING'`, job.id, job.attempt, job.leaseOwner);
      return;
    }
    const chunks = await prisma.$queryRawUnsafe<SourceChunk[]>(`SELECT c.id,c.ordinal,c.text FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
      WHERE d.id=$1 AND d."kbId"=$2 AND d.kind='SOURCE' AND d.status='READY' AND d."sourceVersionId"=$3
      AND c."generationId"=$4 AND c.kind IN ('CHILD','STANDALONE') ORDER BY c.ordinal`,
      job.documentId, job.kbId, job.sourceVersionId, job.generationId);
    if (!chunks.length) throw new Error('SOURCE_CHUNKS_MISSING');
    if (!await reserveCompileBudget(job)) { await pauseForBudget(job); return; }
    called = true;
    const summary = await compileSummary(job.userId, chunks, controller.signal);
    const bytes = Buffer.from(summary.markdown, 'utf8');
    const objectKey = `wiki/${job.kbId}/${job.generationId}/${job.documentId}-summary.md`;
    const { client, bucket } = storage();
    controller.signal.throwIfAborted();
    await client.putObject(bucket, objectKey, bytes, bytes.length, { 'Content-Type': 'text/markdown' });
    const [vector] = await embed([summary.markdown], controller.signal, embeddingModel());
    if (!vector) throw new Error('EMBEDDING_MISSING');
    controller.signal.throwIfAborted();
    await prisma.$transaction(async tx => {
      const valid = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CompileJob" WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3
        AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, job.id, job.attempt, job.leaseOwner);
      if (!valid.length) throw new Error('COMPILE_LEASE_LOST');
      const artifactId = `wiki-summary-${job.id}`;
      await tx.$executeRawUnsafe(`INSERT INTO "Document" (id,"kbId",name,kind,mime,"objectKey",model,size,"chunkCount","chunkStrategy",status,attempt,"createdAt","updatedAt")
        VALUES ($1,$2,$3,'WIKI_SUMMARY','text/markdown',$4,$5,$6,1,'fixed','READY',0,clock_timestamp(),clock_timestamp())
        ON CONFLICT (id) DO NOTHING`, artifactId, job.kbId, `摘要 ${job.documentId}`, objectKey, embeddingModel(), bytes.length);
      await tx.$executeRawUnsafe(`INSERT INTO "Chunk" (id,"kbId","generationId","documentId",kind,ordinal,start,"end",text,embedding)
        VALUES ($1,$2,$3,$4,'STANDALONE',0,0,$5,$6,$7::vector(1024)) ON CONFLICT DO NOTHING`,
        randomUUID(), job.kbId, job.generationId, artifactId, summary.markdown.length, summary.markdown, JSON.stringify(vector));
      for (const fact of summary.facts) await tx.$executeRawUnsafe(`INSERT INTO "SummaryFact" (id,"summaryDocumentId","sourceDocumentId","sourceChunkId",claim,quote,"spanStart","spanEnd")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, randomUUID(), artifactId, job.documentId, fact.sourceChunkId, fact.claim, fact.quote, fact.spanStart, fact.spanEnd);
      await tx.$executeRawUnsafe(`UPDATE "IndexGeneration" g SET
        "documentCount"=(SELECT count(DISTINCT "documentId") FROM "Chunk" WHERE "generationId"=g.id),
        "chunkCount"=(SELECT count(*) FROM "Chunk" WHERE "generationId"=g.id) WHERE g.id=$1`, job.generationId);
      await tx.$executeRawUnsafe(`UPDATE "CompileJob" SET status='SUCCEEDED',"artifactDocumentId"=$4,"leaseOwner"=NULL,
        "leaseExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=clock_timestamp() WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3`,
        job.id, job.attempt, job.leaseOwner, artifactId);
    });
    await prisma.$executeRawUnsafe(`UPDATE "CompileCostLedger" SET "inputTokens"=$2,"outputTokens"=$3,
      "costUsd"=CASE WHEN $2::int IS NULL OR $3::int IS NULL THEN NULL ELSE (($2::numeric*0.28)+($3::numeric*1.10))/1000000 END,
      status=$4,"elapsedMs"=$5 WHERE "requestDedupKey"=$1`, `${job.id}:${job.attempt}`,
      summary.usage.inputTokens, summary.usage.outputTokens,
      summary.usage.inputTokens == null || summary.usage.outputTokens == null ? 'UNKNOWN_COST' : 'SUCCEEDED', Date.now() - started);
    if (summary.rejectedFacts) console.warn('[compile-worker] rejected facts', summary.rejectedFacts);
  } catch (error) {
    if (called) await prisma.$executeRawUnsafe(`UPDATE "CompileCostLedger" SET status='FAILED',"elapsedMs"=$2 WHERE "requestDedupKey"=$1`, `${job.id}:${job.attempt}`, Date.now() - started);
    if (!controller.signal.aborted) await failCompileJob(job, error);
  } finally { clearInterval(heartbeat); }
}

export async function runCompileWorker(owner: string, stopping: () => boolean, once = false): Promise<void> {
  while (!stopping()) {
    let worked = false;
    try {
      worked = await consumeCompileOutbox();
      const job = await claimCompileJob(owner);
      if (job) { await processCompileJob(job); worked = true; }
    } catch (error) { console.error('[compile-worker]', error); }
    if (once || stopping()) break;
    if (!worked) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
