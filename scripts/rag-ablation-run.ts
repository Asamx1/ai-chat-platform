import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as minio from 'minio';
import { prisma } from '../packages/db/src/index';
import { runAblation, type AblationArmName } from '../packages/rag/src/eval/ablation';

const userId = process.env.RAG_ABLATION_USER_ID;
if (!userId) throw new Error('RAG_ABLATION_USER_ID is required');
if (!await prisma.user.findUnique({ where: { id: userId } })) throw new Error('RAG_ABLATION_USER_ID does not exist');
const corpus = await readFile(resolve('scripts/fixtures/rag-ablation.md'));
const text = corpus.toString('utf8');
const kbId = randomUUID();
const documentId = randomUUID();
const conversationId = randomUUID();
const objectKey = `${userId}/${kbId}/${documentId}`;
const endpoint = new URL(process.env.S3_ENDPOINT ?? 'http://localhost:9000');
const bucket = process.env.S3_BUCKET;
if (!bucket || !process.env.MINIO_ROOT_USER || !process.env.MINIO_ROOT_PASSWORD) throw new Error('MinIO configuration is required');
const s3 = new minio.Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || 9000),
  useSSL: endpoint.protocol === 'https:', accessKey: process.env.MINIO_ROOT_USER,
  secretKey: process.env.MINIO_ROOT_PASSWORD });
await s3.putObject(bucket, objectKey, corpus, corpus.length, { 'Content-Type': 'text/markdown' });
await prisma.$transaction(async tx => {
  await tx.knowledgeBase.create({ data: { id: kbId, userId, name: 'RAG ablation fixed corpus' } });
  await tx.conversation.create({ data: { id: conversationId, ownerId: userId, title: 'RAG ablation', type: 'SINGLE' } });
  await tx.conversationKnowledgeBase.create({ data: { conversationId, kbId } });
  await tx.document.create({ data: { id: documentId, kbId, name: 'rag-ablation.md', mime: 'text/markdown',
    objectKey, model: process.env.EMBEDDING_MODEL ?? 'bge-m3:latest', size: corpus.length, status: 'PENDING' } });
});

async function waitFor(label: string, ready: () => Promise<boolean>, timeoutMs = 300_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 2_000)); }
  throw new Error(`${label} timed out; start the KB and compile workers`);
}
await waitFor('document indexing', async () => {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (doc.status === 'FAILED') throw new Error(`document indexing failed: ${doc.error}`);
  return doc.status === 'READY' && !!doc.sourceVersionId;
});
const sourceVersionId = (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).sourceVersionId!;

async function queueGeneration(strategy: 'structure' | 'semantic') {
  const generation = await prisma.indexGeneration.create({ data: { kbId, status: 'BUILDING',
    configSnapshot: { mode: 'rechunk', strategy, sources: [{ id: documentId, sourceVersionId }], targetDocumentCount: 1 } } });
  await prisma.compileJob.create({ data: { kbId, sourceVersionId, generationId: generation.id,
    artifactType: 'RECHUNK', model: 'bge-m3', promptVersion: `rechunk:${strategy}`, schemaVersion: 'v1',
    idempotencyKey: `rechunk:${generation.id}:${documentId}` } });
  await waitFor(`${strategy} generation`, async () => {
    const job = await prisma.compileJob.findFirstOrThrow({ where: { generationId: generation.id, artifactType: 'RECHUNK' } });
    if (job.status === 'FAILED') throw new Error(`${strategy} rebuild failed: ${job.lastError}`);
    return job.status === 'SUCCEEDED';
  });
  return generation.id;
}
const baselineGeneration = await queueGeneration('structure');
const semanticGeneration = await queueGeneration('semantic');
const providerKey = await prisma.apiKey.findUnique({ where: { userId_provider: { userId, provider: 'deepseek' } } });
const hasDeepSeek = !!providerKey;
if (hasDeepSeek) await waitFor('summary compile', async () => {
  const jobs = await prisma.compileJob.findMany({ where: { generationId: { in: [baselineGeneration, semanticGeneration] }, artifactType: 'SUMMARY' } });
  return jobs.length >= 2 && jobs.every(job => job.status === 'SUCCEEDED' || job.status === 'FAILED');
});
const now = new Date().toISOString();
const facts = [
  { id: 'support-hours', question: 'When is Atlas support available?', answer: 'Monday through Friday from 09:00 to 17:00 UTC.', evidence: 'Monday through Friday from 09:00 to 17:00 UTC.', questionType: 'DIRECT_FACT' },
  { id: 'priority-target', question: 'What is the priority incident response target?', answer: 'One business hour.', evidence: 'one business hour', questionType: 'LONG_DOC_LOCAL' },
  { id: 'refund-window', question: 'How long after purchase may a customer request a refund?', answer: 'Within 30 calendar days.', evidence: 'within 30 calendar days', questionType: 'CROSS_DOC' },
] as const;
const cases = facts.map(fact => {
  const start = text.indexOf(fact.evidence);
  if (start < 0) throw new Error(`Missing fixed evidence: ${fact.id}`);
  return { id: fact.id, kbId, question: fact.question, referenceAnswer: fact.answer, questionType: fact.questionType,
    evidenceAnchors: [{ sourceDocumentId: documentId, sourceVersionId, start, end: start + fact.evidence.length,
      evidenceText: fact.evidence, evidenceTextHash: createHash('sha256').update(fact.evidence).digest('hex') }],
    evidenceGroups: [[0]], answerable: true, origin: 'HUMAN_AUTHORED', reviewStatus: 'APPROVED', split: 'DEV',
    reviewedAt: now, createdAt: now };
});
await mkdir(resolve('docs/eval'), { recursive: true });
const date = new Date().toISOString().slice(0, 10);
const datasetPath = resolve(`docs/eval/ablation-dataset-${date}.json`);
await writeFile(datasetPath, JSON.stringify({ version: `fixed-corpus-${date}`, cases }, null, 2));
const generations: Record<AblationArmName, string> = { baseline: baselineGeneration, semantic: semanticGeneration,
  wiki: baselineGeneration, graph: baselineGeneration, combined: semanticGeneration };
const skip = hasDeepSeek ? {} : { wiki: 'DeepSeek ProviderKey unavailable', graph: 'DeepSeek ProviderKey unavailable',
  combined: 'DeepSeek ProviderKey unavailable' };
const report = await runAblation({ datasetPath, userId, conversationId, kbId,
  corpusSnapshotId: createHash('sha256').update(corpus).digest('hex'), generations,
  sourceVersions: { [documentId]: sourceVersionId }, commit: process.env.GIT_COMMIT ?? 'local',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'bge-m3:latest', contextTokenBudget: 4_000, skip });
const prefix = resolve(`docs/eval/ablation-report-${date}`);
await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
const markdown = ['# RAG ablation', '', `Corpus snapshot: ${report.corpusSnapshotId}`, '',
  '| Arm | Status | Evidence coverage@5 | Mean latency ms | Compile USD | Degraded questions |',
  '| --- | --- | ---: | ---: | ---: | --- |',
  ...report.rows.map(row => `| ${row.arm} | ${row.status}${row.reason ? ` (${row.reason})` : ''} | ${row.metrics?.evidenceCoverageAt5 ?? '—'} | ${row.meanLatencyMs ?? '—'} | ${row.cost?.usd ?? 'unknown'} | ${row.degradedQuestions.map(item => item.id).join(', ') || '—'} |`),
  '', 'Question type metrics and per question results are in the JSON report.', ''];
await writeFile(`${prefix}.md`, markdown.join('\n'));
console.log(`${prefix}.json\n${prefix}.md`);
await prisma.$disconnect();
