/**
 * M10-S2 答辩演示一键加载器（幂等，重跑即替换演示 KB）：
 *   pnpm exec tsx experiments/demo-seed.mts
 *
 * 走真实管线：MinIO 对象 + Document(PENDING) → 复用 apps/worker 的
 * processDocument（租约抢占 + 解析/structure 分块 + Ollama 嵌入 + storePlan），
 * 因此演示库与生产上传产物完全一致（headingPath、父子块、READY 状态）。
 *
 * 环境变量（.env，同其他 runner 由 dotenv 加载）：
 *   DATABASE_URL / S3_* / MINIO_ROOT_* / OLLAMA_BASE_URL / EMBEDDING_MODEL
 *   DEMO_EMAIL（默认 demo@example.com）/ DEMO_PASSWORD（默认 demo12345）
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { prisma } from '@aichat/db';
import { embed, embeddingModel } from '../packages/rag/src/embed';
import { processDocument } from '../apps/worker/src/kb-worker';

// minio / better-auth 不是 experiments 的依赖：经各宿主包的 package.json 定位解析。
const workerRequire = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { Client: MinioClient } = workerRequire('minio') as typeof import('minio');

const KB_NAME = '答辩演示库';
const CONVERSATION_TITLE = '答辩演示对话';
const CORPUS_DIR = join(import.meta.dirname, 'demo-corpus');

function storage() {
  const { S3_ENDPOINT, S3_BUCKET, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
    throw new Error('S3_ENDPOINT/S3_BUCKET/MINIO_ROOT_USER/MINIO_ROOT_PASSWORD are required');
  }
  const url = new URL(S3_ENDPOINT);
  return {
    bucket: S3_BUCKET,
    client: new MinioClient({
      endPoint: url.hostname, port: Number(url.port || 9000), useSSL: url.protocol === 'https:',
      accessKey: MINIO_ROOT_USER, secretKey: MINIO_ROOT_PASSWORD,
    }),
  };
}

/** 密码哈希复用 better-auth 的实现（与 apps/web/scripts/seed.ts 相同路径），保证可登录。 */
async function hashPassword(password: string): Promise<string> {
  const { pathToFileURL } = await import('node:url');
  const mod: Record<string, unknown> = await import(pathToFileURL(webRequire.resolve('better-auth/crypto')).href);
  const fn = (mod.hashPassword ?? (mod.default as Record<string, unknown> | undefined)?.hashPassword) as
    | ((password: string) => Promise<string>)
    | undefined;
  if (!fn) throw new Error('better-auth/crypto hashPassword not found');
  return fn(password);
}

async function ensureDemoUser(email: string, password: string): Promise<string> {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, disabled: false },
    create: { email, passwordHash, role: 'USER', name: '答辩演示' },
  });
  // better-auth 邮箱密码登录从 credential Account 取密码，accountId 必须 = userId。
  await prisma.account.upsert({
    where: { providerId_accountId: { providerId: 'credential', accountId: user.id } },
    update: { password: passwordHash, issuer: 'local:credential' },
    create: {
      id: `acct-${user.id}`, userId: user.id, accountId: user.id,
      providerId: 'credential', password: passwordHash, issuer: 'local:credential',
    },
  });
  return user.id;
}

/** 删除旧演示 KB（级联 Document/Chunk/会话关联），并尽力清掉 MinIO 对象。 */
async function replaceExistingKb(userId: string): Promise<void> {
  const { client, bucket } = storage();
  const stale = await prisma.knowledgeBase.findMany({ where: { userId, name: KB_NAME }, select: { id: true } });
  for (const kb of stale) {
    const prefix = `${userId}/${kb.id}/`;
    const objects: string[] = [];
    try {
      for await (const item of client.listObjectsV2(bucket, prefix, true)) {
        if (typeof item.name === 'string') objects.push(item.name);
      }
      for (const name of objects) await client.removeObject(bucket, name);
    } catch (error) { console.warn(`[demo-seed] MinIO cleanup skipped for ${prefix}: ${error}`); }
    await prisma.knowledgeBase.delete({ where: { id: kb.id } });
  }
}

type ClaimedJob = { id: string; attempt: number; mime: string; objectKey: string; model: string; size: number; chunkStrategy: string };

/** 复刻 kb-worker 的租约抢占（按 id 定向、租约 10 分钟），随后交给真实 processDocument。 */
async function claimLease(documentId: string): Promise<ClaimedJob> {
  const rows = await prisma.$queryRawUnsafe<ClaimedJob[]>(
    `UPDATE "Document" SET status='PROCESSING', attempt=attempt+1,
       "leaseOwner"='demo-seed', "leaseExpiresAt"=clock_timestamp()+interval '10 minutes',
       error=NULL, "updatedAt"=clock_timestamp()
     WHERE id=$1 RETURNING id, attempt, mime, "objectKey", model, size, "chunkStrategy"`, documentId);
  if (!rows[0]) throw new Error(`lease claim failed for ${documentId}`);
  return rows[0];
}

async function ingestDoc(userId: string, kbId: string, filePath: string): Promise<void> {
  const data = readFileSync(filePath);
  const documentId = randomUUID();
  const objectKey = `${userId}/${kbId}/${documentId}`;
  const { client, bucket } = storage();
  await client.putObject(bucket, objectKey, data, data.byteLength, { 'Content-Type': 'text/markdown' });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Document" (id, "kbId", name, mime, "objectKey", model, size, status, "chunkCount", attempt, "createdAt", "updatedAt")
     VALUES ($1,$2,$3,'text/markdown',$4,$5,$6,'PENDING',0,0,NOW(),NOW())`,
    documentId, kbId, filePath.split('/').pop(), objectKey, embeddingModel(), data.byteLength);
  const job = await claimLease(documentId);
  await processDocument(job, 'demo-seed'); // 内部吞错，事后按状态校验
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { status: true, chunkCount: true, error: true } });
  if (doc?.status !== 'READY') {
    throw new Error(`ingest failed for ${objectKey}: status=${doc?.status} error=${doc?.error ?? 'unknown'}`);
  }
  console.log(`[demo-seed] READY ${filePath.split('/').pop()} (${doc.chunkCount} chunks)`);
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const email = process.env.DEMO_EMAIL || 'demo@example.com';
  const password = process.env.DEMO_PASSWORD || 'demo12345';

  await embed(['probe'], AbortSignal.timeout(60_000)); // Ollama 不可达时快速失败
  const userId = await ensureDemoUser(email, password);
  await replaceExistingKb(userId);

  const kbId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "KnowledgeBase" (id, "userId", name, "createdAt", "updatedAt") VALUES ($1,$2,$3,NOW(),NOW())`,
    kbId, userId, KB_NAME);

  const files = readdirSync(CORPUS_DIR).filter(name => name.endsWith('.md')).sort();
  if (!files.length) throw new Error(`no corpus files under ${CORPUS_DIR}`);
  for (const name of files) await ingestDoc(userId, kbId, join(CORPUS_DIR, name));

  // 演示会话：幂等——先删同名旧会话，再重建并绑定演示 KB。
  await prisma.conversation.deleteMany({ where: { ownerId: userId, title: CONVERSATION_TITLE } });
  const conversation = await prisma.conversation.create({
    data: { ownerId: userId, title: CONVERSATION_TITLE, type: 'SINGLE' },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ConversationKnowledgeBase" ("conversationId", "kbId") VALUES ($1,$2)`,
    conversation.id, kbId);

  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  console.log('\n=== 答辩演示库就绪 ===');
  console.log(`登录:   ${base}/login  (${email} / ${password})`);
  console.log(`知识库: ${base}/kb/${kbId}`);
  console.log(`会话:   ${base}/  (对话「${CONVERSATION_TITLE}」已绑定演示库)`);
  console.log(`文档数: ${files.length}，策略 structure，嵌入模型 ${embeddingModel()}`);
}

if (process.argv[1]?.endsWith('demo-seed.mts')) {
  main().then(() => prisma.$disconnect()).catch(async error => {
    console.error(error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
