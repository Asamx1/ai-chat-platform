-- M9 RAG quality: incremental columns only (nullable or defaulted); existing data untouched.
-- The tsvector generated column and its GIN index cannot be expressed in schema.prisma;
-- this file is the source of truth for them (see the schema comment on Chunk.tsv).
BEGIN;

-- Transaction-local settings: fail fast on lock contention, never touch global config.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "Document"
  ADD COLUMN "chunkStrategy" TEXT NOT NULL DEFAULT 'structure';

ALTER TABLE "Chunk"
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "headingPath" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CHILD';

ALTER TABLE "Chunk"
  ADD CONSTRAINT "Chunk_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Chunk"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Chunk_parentId_idx" ON "Chunk" ("parentId");

ALTER TABLE "Chunk" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('pg_catalog.simple'::regconfig, coalesce("text", ''))
  ) STORED;

CREATE INDEX "chunk_tsv_idx" ON "Chunk" USING GIN ("tsv" tsvector_ops);

COMMIT;
