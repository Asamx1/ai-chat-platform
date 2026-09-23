import { PermanentRagError } from './parse';
export const EMBEDDING_DIMENSIONS = 1024;
export const embeddingModel = (): string => process.env.EMBEDDING_MODEL || 'bge-m3:latest';
export function validateVector(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
      !value.every(n => typeof n === 'number' && Number.isFinite(n)) || !value.some(n => n !== 0)) {
    throw new PermanentRagError('INVALID_EMBEDDING');
  }
}
function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** Queue attempts provide retries; this function never multiplies the attempt budget. */
export async function embed(texts: string[], signal: AbortSignal, model = embeddingModel()): Promise<number[][]> {
  const batchSize = positiveInteger(process.env.EMBED_BATCH, 16);
  const numParallel = positiveInteger(process.env.OLLAMA_NUM_PARALLEL, 4);
  // Batches of texts travel through at most this many concurrent /api/embed calls;
  // Ollama bge-m3 handles long batches, so 16×2 keeps the GPU busy without queue thrash.
  const maxInFlight = positiveInteger(process.env.EMBED_CONCURRENCY, 2);
  const vectors: number[][] = new Array(texts.length);
  let nextBatch = 0;
  const batchCount = Math.ceil(texts.length / batchSize);
  const sendBatch = async (): Promise<void> => {
    for (;;) {
      const index = nextBatch++;
      if (index >= batchCount) return;
      const input = texts.slice(index * batchSize, (index + 1) * batchSize);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error('EMBED_TIMEOUT')), 60_000);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        combined.throwIfAborted();
        const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/embed`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: combined,
          body: JSON.stringify({ model, input, truncate: false, keep_alive: '30m', num_parallel: numParallel }),
        });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
            throw new PermanentRagError(`EMBED_HTTP_${response.status}`);
          }
          throw new Error(`EMBED_HTTP_${response.status}`);
        }
        const body = await response.json() as { embeddings?: unknown };
        if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
          throw new PermanentRagError('INVALID_EMBEDDING_COUNT');
        }
        body.embeddings.forEach((vector, offset) => {
          validateVector(vector);
          vectors[index * batchSize + offset] = vector;
        });
      } finally { clearTimeout(timer); }
    }
  };
  // One shared worker pool: results land by index so ordering survives the concurrency.
  await Promise.all(Array.from({ length: Math.min(maxInFlight, batchCount) }, () => sendBatch()));
  return vectors;
}
