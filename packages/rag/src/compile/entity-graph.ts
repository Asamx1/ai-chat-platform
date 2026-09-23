import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import { extractChunk } from '../graph/extract';
import { loadOntology, ontologySchema } from '../graph/ontology';
import { storeGraph } from '../graph/store-graph';
import type { GraphSource } from '../graph/store-graph';
import type { CompileJobRow } from './compile-job';
import { pauseForBudget } from './compile-job';

/** Explicit opt-in enqueue; one KB-wide job per generation and ontology snapshot. */
export async function enqueueEntityGraph(kbId: string, generationId: string, sourceVersionId: string): Promise<string> {
  return prisma.$transaction(async tx => {
    const [generation] = await tx.$queryRawUnsafe<{ configSnapshot: unknown }[]>(`SELECT "configSnapshot" FROM "IndexGeneration" WHERE id=$1 AND "kbId"=$2 AND status IN ('BUILDING','ACTIVE') FOR UPDATE`, generationId, kbId);
    if (!generation) throw new Error('GRAPH_GENERATION_SCOPE');
    const versions = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "SourceVersion" WHERE id=$1 AND "kbId"=$2`, sourceVersionId, kbId);
    if (!versions.length) throw new Error('GRAPH_SOURCE_SCOPE');
    const ontology = await loadOntology(kbId, tx);
    const snapshot = generation.configSnapshot as { graphOntology?: unknown };
    if (snapshot.graphOntology && JSON.stringify(ontologySchema.parse(snapshot.graphOntology)) !== JSON.stringify(ontology)) throw new Error('GRAPH_ONTOLOGY_REQUIRES_NEW_GENERATION');
    await tx.$executeRawUnsafe(`UPDATE "IndexGeneration" SET "configSnapshot"="configSnapshot" || jsonb_build_object('graphOntology',$2::jsonb) WHERE id=$1`, generationId, JSON.stringify(ontology));
    const key = createHash('sha256').update(`${kbId}:${generationId}:ENTITY_GRAPH:v1:${JSON.stringify(ontology)}`).digest('hex');
    const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "CompileJob" (id,"kbId","sourceVersionId","generationId","artifactType",model,"promptVersion","schemaVersion",status,attempt,"maxAttempts","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'ENTITY_GRAPH','deepseek-chat','v1',$5,'PENDING',0,2,$6,clock_timestamp(),clock_timestamp())
      ON CONFLICT ("idempotencyKey") DO UPDATE SET "idempotencyKey"=EXCLUDED."idempotencyKey" RETURNING id`, randomUUID(), kbId, sourceVersionId, generationId, ontology.version, key);
    if (!job) throw new Error('GRAPH_ENQUEUE_FAILED');
    return job.id;
  });
}
export async function compileEntityGraph(job: CompileJobRow, signal: AbortSignal, reserve: (job: CompileJobRow, requestKey: string) => Promise<boolean>): Promise<void> {
  const [generation] = await prisma.$queryRawUnsafe<{ configSnapshot: { graphOntology?: unknown } }[]>(`SELECT "configSnapshot" FROM "IndexGeneration" WHERE id=$1 AND "kbId"=$2`, job.generationId, job.kbId);
  const ontology = ontologySchema.parse(generation?.configSnapshot.graphOntology);
  const chunks = await prisma.$queryRawUnsafe<GraphSource[]>(`SELECT c.id AS "chunkId",c."kbId",c."generationId",c."documentId",d."sourceVersionId",c.text FROM "Chunk" c
    JOIN "Document" d ON d.id=c."documentId" JOIN "SourceVersion" v ON v.id=d."sourceVersionId" AND v."documentId"=d.id AND v."kbId"=d."kbId"
    WHERE c."kbId"=$1 AND d."kbId"=$1 AND c."generationId"=$2 AND d.kind='SOURCE' AND d.status='READY'
      AND c.kind IN ('CHILD','STANDALONE') ORDER BY c."documentId",c.ordinal,c.id`, job.kbId, job.generationId);
  for (const source of chunks) {
    signal.throwIfAborted();
    const requestKey = `${job.id}:${job.attempt}:${source.chunkId}:${source.sourceVersionId}`;
    const completed = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "CompileCostLedger" WHERE "compileJobId"=$1 AND status IN ('SUCCEEDED','UNKNOWN_COST') AND ends_with("requestDedupKey",$2) LIMIT 1`, job.id, `:${source.chunkId}:${source.sourceVersionId}`);
    if (completed.length) continue;
    if (!await reserve(job, requestKey)) { await pauseForBudget(job); return; }
    const started = Date.now();
    try {
      const extracted = await extractChunk(job.userId, source.text, ontology, signal);
      signal.throwIfAborted();
      await storeGraph(source, extracted, ontology, prisma, job);
      await prisma.$executeRawUnsafe(`UPDATE "CompileCostLedger" SET "inputTokens"=$2,"outputTokens"=$3,
        "costUsd"=CASE WHEN $2::int IS NULL OR $3::int IS NULL THEN NULL ELSE ($2::numeric*0.28+$3::numeric*1.10)/1000000 END,
        status=$4,"elapsedMs"=$5 WHERE "requestDedupKey"=$1`, requestKey, extracted.usage.inputTokens, extracted.usage.outputTokens,
      extracted.usage.inputTokens === null || extracted.usage.outputTokens === null ? 'UNKNOWN_COST' : 'SUCCEEDED', Date.now() - started);
    } catch (error) {
      await prisma.$executeRawUnsafe(`UPDATE "CompileCostLedger" SET status='FAILED',"elapsedMs"=$2 WHERE "requestDedupKey"=$1`, requestKey, Date.now() - started);
      throw error;
    }
  }
  signal.throwIfAborted();
  const finished = await prisma.$executeRawUnsafe(`UPDATE "CompileJob" SET status='SUCCEEDED',"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=clock_timestamp()
    WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='RUNNING' AND "leaseExpiresAt">clock_timestamp()`, job.id, job.attempt, job.leaseOwner);
  if (!finished) throw new Error('COMPILE_LEASE_LOST');
}
