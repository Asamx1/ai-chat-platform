import { randomUUID } from 'node:crypto';
import { prisma } from '@aichat/db';
import type { Slice } from './chunk';
import { validateVector } from './embed';
import { PermanentRagError } from './parse';
export class LeaseLostError extends Error {}
export async function store(id: string, attempt: number, worker: string, slices: Slice[], vectors: number[][]): Promise<void> {
  if (!slices.length || slices.length !== vectors.length) throw new PermanentRagError('INVALID_CHUNKS');
  vectors.forEach(validateVector);
  await prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "Document" WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3
       AND status='PROCESSING' AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`, id, attempt, worker);
    if (!rows.length) throw new LeaseLostError('LEASE_LOST');
    await tx.$executeRawUnsafe('DELETE FROM "Chunk" WHERE "documentId"=$1', id);
    for (const [i, slice] of slices.entries()) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Chunk" (id,"documentId",ordinal,start,"end",text,embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector(1024))`,
        randomUUID(), id, slice.ordinal, slice.start, slice.end, slice.text, JSON.stringify(vectors[i]));
    }
    const count = await tx.$executeRawUnsafe(
      `UPDATE "Document" SET status='READY',"chunkCount"=$4,error=NULL,"leaseOwner"=NULL,
       "leaseExpiresAt"=NULL,"updatedAt"=clock_timestamp()
       WHERE id=$1 AND attempt=$2 AND "leaseOwner"=$3 AND status='PROCESSING'
       AND "leaseExpiresAt">clock_timestamp()`, id, attempt, worker, slices.length);
    if (count !== 1) throw new LeaseLostError('LEASE_LOST');
  }, { timeout: 25_000 });
}
