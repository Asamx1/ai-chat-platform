import { prisma } from '@aichat/db';
import type { RagHit, RagSnapshot } from '@aichat/rag';
export { injectContext } from '@aichat/rag';
export type { RagHit, RagSnapshot } from '@aichat/rag';

async function deadline<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('RAG_UNAVAILABLE')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

function topHits(hits: RagHit[]): RagHit[] {
  return hits.filter(hit => typeof hit.documentId === 'string' && Number.isInteger(hit.ordinal) && hit.ordinal >= 0 &&
    typeof hit.name === 'string' && typeof hit.text === 'string' && Number.isFinite(hit.distance))
    .sort((a, b) => a.distance - b.distance).slice(0, 5);
}

export async function retrieveContext(userId: string, conversationId: string, query: string): Promise<RagSnapshot> {
  try {
    return await deadline<RagSnapshot>(async () => {
      const mounted = await prisma.$queryRaw<{ kbId: string }[]>`
        SELECT m."kbId" FROM "ConversationKnowledgeBase" m
        JOIN "KnowledgeBase" k ON k.id = m."kbId" JOIN "Conversation" v ON v.id = m."conversationId"
        WHERE v.id = ${conversationId} AND v."ownerId" = ${userId} AND k."userId" = ${userId} LIMIT 1`;
      if (!mounted.length) return { status: 'SKIPPED', hits: [] };
      // §2 package boundary; lazily load so unmounted conversations never embed.
      const { retrieve } = await import('@aichat/rag');
      return { status: 'READY', hits: topHits(await retrieve(userId, conversationId, query)) };
    });
  } catch { return { status: 'RAG_UNAVAILABLE', hits: [] }; }
}

export async function revalidateContext(userId: string, conversationId: string, snapshot: RagSnapshot): Promise<RagSnapshot> {
  if (!snapshot.hits.length) return snapshot;
  try {
    const hits = await deadline(async () => {
      const valid: RagHit[] = [];
      for (const hit of topHits(snapshot.hits)) {
        const rows = await prisma.$queryRaw<Omit<RagHit, 'distance'>[]>`
          SELECT c."documentId", c.ordinal, d.name, c.text, c."headingPath" FROM "Chunk" c
          JOIN "Document" d ON d.id = c."documentId" JOIN "KnowledgeBase" k ON k.id = d."kbId"
          JOIN "ConversationKnowledgeBase" m ON m."kbId" = k.id JOIN "Conversation" v ON v.id = m."conversationId"
          WHERE c."documentId" = ${hit.documentId} AND c.ordinal = ${hit.ordinal}
            AND d.status = 'READY' AND d.model = ${process.env.EMBEDDING_MODEL || 'bge-m3:latest'}
            AND k."userId" = ${userId} AND v."ownerId" = ${userId} AND v.id = ${conversationId}`;
        if (rows[0]) valid.push({ ...rows[0], distance: hit.distance });
      }
      return valid;
    });
    return { status: 'READY', hits };
  } catch { return { status: 'RAG_UNAVAILABLE', hits: [] }; }
}
