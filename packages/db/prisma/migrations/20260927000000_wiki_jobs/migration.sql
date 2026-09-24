CREATE TABLE "WikiJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "kind" TEXT NOT NULL CHECK ("kind" IN ('scan_backlog', 'lint_check', 'reextract', 'republish')),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 3),
  "fingerprint" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "result" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "WikiJob_vault_id_kind_fingerprint_key" ON "WikiJob" ("vault_id", "kind", "fingerprint");
CREATE INDEX "WikiJob_vault_id_status_created_at_idx" ON "WikiJob" ("vault_id", "status", "created_at");
