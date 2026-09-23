BEGIN;
CREATE TYPE "IndexGenerationStatus" AS ENUM ('BUILDING', 'ACTIVE', 'RETIRED', 'FAILED');
CREATE TABLE "SourceVersion" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL, "documentId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL, "parserVersion" TEXT NOT NULL, "normalizerVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "IndexGeneration" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL,
  "status" "IndexGenerationStatus" NOT NULL DEFAULT 'BUILDING', "configSnapshot" JSONB NOT NULL,
  "documentCount" INTEGER NOT NULL DEFAULT 0, "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3), "retiredAt" TIMESTAMP(3)
);
CREATE TABLE "CompileJob" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL, "sourceVersionId" TEXT NOT NULL,
  "generationId" TEXT NOT NULL, "artifactType" TEXT NOT NULL, "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL, "schemaVersion" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0, "maxAttempts" INTEGER NOT NULL DEFAULT 2,
  "idempotencyKey" TEXT NOT NULL, "leaseOwner" TEXT, "leaseExpiresAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "KnowledgeBase" ADD COLUMN "activeGenerationId" TEXT;
ALTER TABLE "Document" ADD COLUMN "sourceVersionId" TEXT;
ALTER TABLE "Chunk" ADD COLUMN "generationId" TEXT, ADD COLUMN "kbId" TEXT;

INSERT INTO "IndexGeneration" ("id", "kbId", "status", "configSnapshot", "activatedAt")
SELECT 'legacy-generation-' || id, id, 'ACTIVE', '{}'::jsonb, CURRENT_TIMESTAMP FROM "KnowledgeBase";
UPDATE "KnowledgeBase" SET "activeGenerationId" = 'legacy-generation-' || id;
INSERT INTO "SourceVersion" ("id", "kbId", "documentId", "contentHash", "parserVersion", "normalizerVersion")
SELECT 'legacy-source-' || id, "kbId", id, 'legacy-' || id, 'legacy', 'legacy' FROM "Document";
UPDATE "Document" SET "sourceVersionId" = 'legacy-source-' || id;
UPDATE "Chunk" c SET "kbId" = d."kbId", "generationId" = k."activeGenerationId"
FROM "Document" d JOIN "KnowledgeBase" k ON k.id = d."kbId" WHERE d.id = c."documentId";
ALTER TABLE "Chunk" ALTER COLUMN "kbId" SET NOT NULL;
UPDATE "IndexGeneration" g SET
  "documentCount" = (SELECT count(DISTINCT c."documentId") FROM "Chunk" c WHERE c."generationId" = g.id),
  "chunkCount" = (SELECT count(*) FROM "Chunk" c WHERE c."generationId" = g.id);

-- The initial RAG migration creates this as a unique INDEX, not a table constraint.
DROP INDEX "Chunk_documentId_ordinal_key";
CREATE UNIQUE INDEX "Chunk_documentId_generationId_ordinal_key" ON "Chunk"("documentId", "generationId", "ordinal");
CREATE INDEX "Chunk_kbId_generationId_idx" ON "Chunk"("kbId", "generationId");
CREATE UNIQUE INDEX "KnowledgeBase_activeGenerationId_key" ON "KnowledgeBase"("activeGenerationId");
CREATE UNIQUE INDEX "SourceVersion_documentId_contentHash_key" ON "SourceVersion"("documentId", "contentHash");
CREATE UNIQUE INDEX "CompileJob_idempotencyKey_key" ON "CompileJob"("idempotencyKey");
CREATE INDEX "IndexGeneration_kbId_status_idx" ON "IndexGeneration"("kbId", "status");
ALTER TABLE "SourceVersion" ADD CONSTRAINT "SourceVersion_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceVersion" ADD CONSTRAINT "SourceVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_activeGenerationId_fkey" FOREIGN KEY ("activeGenerationId") REFERENCES "IndexGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "IndexGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "IndexGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
