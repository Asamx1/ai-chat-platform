BEGIN;
ALTER TABLE "Document" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'SOURCE';
UPDATE "Document" SET "kind"='SOURCE';
ALTER TABLE "CompileJob" ADD COLUMN "artifactDocumentId" TEXT;
CREATE TABLE "CompileOutbox" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL, "documentId" TEXT NOT NULL,
  "sourceVersionId" TEXT NOT NULL, "generationId" TEXT NOT NULL, "eventType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "CompileOutbox_documentId_sourceVersionId_generationId_eventType_key" ON "CompileOutbox"("documentId","sourceVersionId","generationId","eventType");
CREATE INDEX "CompileOutbox_processedAt_createdAt_idx" ON "CompileOutbox"("processedAt","createdAt");
ALTER TABLE "CompileOutbox" ADD CONSTRAINT "CompileOutbox_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompileJob" ADD CONSTRAINT "CompileJob_artifactDocumentId_fkey" FOREIGN KEY ("artifactDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "CompileCostLedger" (
  "id" TEXT NOT NULL PRIMARY KEY, "kbId" TEXT NOT NULL, "compileJobId" TEXT NOT NULL,
  "model" TEXT NOT NULL, "operation" TEXT NOT NULL, "inputTokens" INTEGER, "outputTokens" INTEGER,
  "costUsd" DECIMAL(12,6), "priceVersion" TEXT NOT NULL, "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL, "elapsedMs" INTEGER, "requestDedupKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CompileCostLedger_requestDedupKey_key" ON "CompileCostLedger"("requestDedupKey");
CREATE INDEX "CompileCostLedger_kbId_createdAt_idx" ON "CompileCostLedger"("kbId","createdAt");
ALTER TABLE "CompileCostLedger" ADD CONSTRAINT "CompileCostLedger_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompileCostLedger" ADD CONSTRAINT "CompileCostLedger_compileJobId_fkey" FOREIGN KEY ("compileJobId") REFERENCES "CompileJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "SummaryFact" (
  "id" TEXT NOT NULL PRIMARY KEY, "summaryDocumentId" TEXT NOT NULL, "sourceDocumentId" TEXT NOT NULL,
  "sourceChunkId" TEXT NOT NULL, "claim" TEXT NOT NULL, "quote" TEXT NOT NULL,
  "spanStart" INTEGER NOT NULL, "spanEnd" INTEGER NOT NULL
);
CREATE INDEX "SummaryFact_summaryDocumentId_idx" ON "SummaryFact"("summaryDocumentId");
ALTER TABLE "SummaryFact" ADD CONSTRAINT "SummaryFact_summaryDocumentId_fkey" FOREIGN KEY ("summaryDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SummaryFact" ADD CONSTRAINT "SummaryFact_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SummaryFact" ADD CONSTRAINT "SummaryFact_sourceChunkId_fkey" FOREIGN KEY ("sourceChunkId") REFERENCES "Chunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
