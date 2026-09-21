import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { prisma } from '@aichat/db';
import { chunk, embed, embeddingModel, parse, store, PermanentRagError, LeaseLostError, MAX_FILE_BYTES } from '@aichat/rag';

type Job = { id: string; attempt: number; mime: string; objectKey: string; model: string; size: number };
export async function claimDocument(worker: string): Promise<Job | null> {
  // Recovery is deliberately restricted to exhausted, expired leases.
  await prisma.$executeRawUnsafe(`UPDATE "Document" SET status='FAILED',error='ATTEMPTS_EXHAUSTED',
    "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
    WHERE attempt>=3 AND (status='PENDING' OR (status='PROCESSING' AND
      ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=clock_timestamp())))`);
  const rows = await prisma.$queryRawUnsafe<Job[]>(`UPDATE "Document" SET status='PROCESSING',
    attempt=attempt+1,"leaseOwner"=$1,"leaseExpiresAt"=clock_timestamp()+interval '30 seconds',
    error=NULL,"updatedAt"=clock_timestamp()
    WHERE id=(SELECT id FROM "Document" WHERE attempt<3 AND
      (status='PENDING' OR (status='PROCESSING' AND
       ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<=clock_timestamp())))
      ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,attempt,mime,"objectKey",model,size`, worker);
  return rows[0] ?? null;
}
export async function renewDocument(job: Job, worker: string): Promise<number> {
  return prisma.$executeRawUnsafe(`UPDATE "Document" SET "leaseExpiresAt"=clock_timestamp()+interval '30 seconds',
    "updatedAt"=clock_timestamp() WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3
    AND status='PROCESSING' AND "leaseExpiresAt">clock_timestamp()`, job.id, job.attempt, worker);
}
export async function failDocument(job: Job, worker: string, error: unknown): Promise<void> {
  const permanent = error instanceof PermanentRagError;
  await prisma.$executeRawUnsafe(`UPDATE "Document" SET status=$4::"DocumentStatus",error=$5,
    "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
    WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='PROCESSING'
    AND "leaseExpiresAt">clock_timestamp()`, job.id, job.attempt, worker,
    permanent || job.attempt >= 3 ? 'FAILED' : 'PENDING',
    (error instanceof Error ? error.message : 'RAG_FAILED').slice(0, 1000));
}

function parsePdf(data: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const pdfModule = createRequire(import.meta.url).resolve('pdf-parse');
  return new Promise((resolve, reject) => {
    const thread = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { PDFParse } = await import(require('node:url').pathToFileURL(workerData.module).href);
        const parser = new PDFParse({ data: workerData.data });
        try {
          const result = await parser.getText();
          if (Array.from(result.text).length > 2000000) throw new Error('TEXT_TOO_LARGE');
          parentPort.postMessage({ text: result.text });
        } finally { await parser.destroy(); }
      })().catch(error => parentPort.postMessage({ error: String(error) }));
    `, { eval: true, workerData: { data, module: pdfModule } });
    let settled = false;
    const finish = (error?: Error, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void thread.terminate();
      if (error) reject(error); else resolve(text ?? '');
    };
    const abort = (): void => finish(new LeaseLostError('LEASE_LOST'));
    const timer = setTimeout(() => finish(new PermanentRagError('PDF_TIMEOUT')), 60_000);
    signal.addEventListener('abort', abort, { once: true });
    thread.once('message', (message: { text?: string; error?: string }) =>
      finish(message.error ? new PermanentRagError(message.error) : undefined, message.text));
    thread.once('error', error => finish(new PermanentRagError(error.message)));
    thread.once('exit', code => { if (code !== 0) finish(new PermanentRagError('PDF_WORKER_EXIT')); });
  });
}

async function readObject(job: Job, signal: AbortSignal): Promise<Uint8Array> {
  if (job.size > MAX_FILE_BYTES || job.size < 0) throw new PermanentRagError('FILE_TOO_LARGE');
  const { Client } = await import('minio');
  const client = new Client({
    endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
    port: Number(process.env.MINIO_PORT || 9000), useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || '',
    secretKey: process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || '',
  });
  client.setRequestOptions({ timeout: 60_000 });
  const stream = await client.getObject(process.env.MINIO_BUCKET || 'knowledge-base', job.objectKey);
  const abort = (): void => { stream.destroy(new Error('OBJECT_READ_ABORTED')); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const buffers: Buffer[] = [];
  try {
    signal.throwIfAborted();
    for await (const value of stream) {
      const buffer = Buffer.from(value as Uint8Array);
      size += buffer.length;
      if (size > MAX_FILE_BYTES) throw new PermanentRagError('FILE_TOO_LARGE');
      buffers.push(buffer);
    }
    if (size !== job.size) throw new PermanentRagError('FILE_SIZE_MISMATCH');
    return Buffer.concat(buffers);
  } finally { signal.removeEventListener('abort', abort); stream.destroy(); }
}

export async function processDocument(job: Job, worker: string): Promise<void> {
  const controller = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewDocument(job, worker).then(count => {
      if (count !== 1) controller.abort();
    }).catch(() => controller.abort()).finally(() => { renewing = false; });
  }, 10_000);
  try {
    if (job.model !== embeddingModel()) throw new PermanentRagError('EMBEDDING_MODEL_MISMATCH');
    const data = await readObject(job, controller.signal);
    const parts = await parse(data, job.mime, bytes => parsePdf(bytes, controller.signal));
    const slices = chunk(parts);
    const vectors = await embed(slices.map(slice => slice.text), controller.signal, job.model);
    controller.signal.throwIfAborted();
    await store(job.id, job.attempt, worker, slices, vectors);
  } catch (error) {
    if (!controller.signal.aborted && !(error instanceof LeaseLostError)) await failDocument(job, worker, error);
  } finally { clearInterval(heartbeat); }
}

export async function runKbWorker(worker: string, stopping: () => boolean, once = false): Promise<void> {
  // Probe failures affect only this independent loop; never block chat startup.
  let probed = false;
  while (!stopping()) {
    try {
      if (!probed) { await embed(['probe'], AbortSignal.timeout(60_000)); probed = true; }
      const job = await claimDocument(worker);
      if (job) await processDocument(job, worker);
    } catch (error) { console.error('[kb-worker]', error); }
    if (once || stopping()) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
