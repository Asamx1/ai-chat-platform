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
  const batchSize = positiveInteger(process.env.EMBED_BATCH, 64);
  const numParallel = positiveInteger(process.env.OLLAMA_NUM_PARALLEL, 4);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('EMBED_TIMEOUT')), 60_000);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      combined.throwIfAborted();
      const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: combined,
        body: JSON.stringify({ model, input: texts.slice(i, i + batchSize), truncate: false, keep_alive: '30m', num_parallel: numParallel }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
          throw new PermanentRagError(`EMBED_HTTP_${response.status}`);
        }
        throw new Error(`EMBED_HTTP_${response.status}`);
      }
      const body = await response.json() as { embeddings?: unknown };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== Math.min(batchSize, texts.length - i)) {
        throw new PermanentRagError('INVALID_EMBEDDING_COUNT');
      }
      for (const vector of body.embeddings) { validateVector(vector); vectors.push(vector); }
    } finally { clearTimeout(timer); }
  }
  return vectors;
}
