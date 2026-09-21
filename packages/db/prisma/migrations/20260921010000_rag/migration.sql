CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');
CREATE TABLE "KnowledgeBase" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "Document" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL, "objectKey" TEXT NOT NULL, "model" TEXT NOT NULL, "size" INTEGER NOT NULL,
  "chunkCount" INTEGER NOT NULL DEFAULT 0, "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT, "attempt" INTEGER NOT NULL DEFAULT 0, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "Chunk" (
  "id" TEXT NOT NULL PRIMARY KEY, "documentId" TEXT NOT NULL, "ordinal" INTEGER NOT NULL,
  "start" INTEGER NOT NULL, "end" INTEGER NOT NULL, "text" TEXT NOT NULL, "embedding" vector(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ConversationKnowledgeBase" (
  "conversationId" TEXT NOT NULL, "kbId" TEXT NOT NULL,
  CONSTRAINT "ConversationKnowledgeBase_pkey" PRIMARY KEY ("conversationId", "kbId")
);
CREATE INDEX "KnowledgeBase_userId_updatedAt_idx" ON "KnowledgeBase"("userId", "updatedAt");
CREATE UNIQUE INDEX "Document_objectKey_key" ON "Document"("objectKey");
CREATE INDEX "Document_kbId_createdAt_idx" ON "Document"("kbId", "createdAt");
CREATE INDEX "Document_status_leaseExpiresAt_idx" ON "Document"("status", "leaseExpiresAt");
CREATE UNIQUE INDEX "Chunk_documentId_ordinal_key" ON "Chunk"("documentId", "ordinal");
CREATE INDEX "ConversationKnowledgeBase_kbId_idx" ON "ConversationKnowledgeBase"("kbId");
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationKnowledgeBase" ADD CONSTRAINT "ConversationKnowledgeBase_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationKnowledgeBase" ADD CONSTRAINT "ConversationKnowledgeBase_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
