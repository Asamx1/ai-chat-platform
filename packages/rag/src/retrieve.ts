import { prisma } from '@aichat/db';
import { embed, embeddingModel, validateVector } from './embed';
export type Hit = { documentId: string; ordinal: number; name: string; text: string; distance: number };
export async function retrieve(userId: string, conversationId: string, query: string): Promise<Hit[]> {
  const model = embeddingModel();
  const [vector] = await embed([query], AbortSignal.timeout(3_000), model);
  validateVector(vector);
  return prisma.$queryRawUnsafe<Hit[]>(
    `SELECT c."documentId",c.ordinal,d.name,c.text,c.embedding <=> $1::vector(1024) AS distance
     FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId"
     JOIN "KnowledgeBase" k ON k.id=d."kbId"
     JOIN "ConversationKnowledgeBase" m ON m."kbId"=k.id
     JOIN "Conversation" v ON v.id=m."conversationId"
     WHERE k."userId"=$2 AND v."ownerId"=$2 AND v.id=$3 AND d.status='READY' AND d.model=$4
     ORDER BY distance,c.id LIMIT 5`, JSON.stringify(vector), userId, conversationId, model);
}
