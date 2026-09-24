-- Independent Vault tables. Existing KB tables are unchanged.
CREATE TABLE "VaultSource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "family_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "file_path" TEXT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "bytes" BIGINT NOT NULL,
  "added_by" TEXT NOT NULL DEFAULT 'user',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "VaultSourceFamily" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "family_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "VaultPage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "page_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "file_path" TEXT NOT NULL,
  "ontology_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "VaultAssertion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "subject_id" TEXT NOT NULL,
  "predicate" TEXT NOT NULL,
  "object_id" TEXT,
  "value" TEXT,
  "polarity" BOOLEAN NOT NULL,
  "conditions" TEXT,
  "valid_from" TEXT,
  "valid_to" TEXT,
  "status" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "rule_id" TEXT,
  "rule_version" TEXT,
  "revision" TEXT NOT NULL,
  "page_id" TEXT,
  "ontology_version" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "VaultEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "assertion_id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_sha256" VARCHAR(64) NOT NULL,
  "locator_kind" TEXT NOT NULL,
  "locator_json" TEXT NOT NULL,
  "quote" VARCHAR(500) NOT NULL,
  "stance" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "VaultRelease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "revision" TEXT NOT NULL,
  "ontology_version" TEXT NOT NULL,
  "rules_version" TEXT NOT NULL,
  "files_json" JSONB NOT NULL,
  "baseline_hash" TEXT NOT NULL,
  "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL,
  "git_commit" TEXT
);
CREATE TABLE "VaultEntityCandidate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "canonical_name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "promoted_page_id" TEXT,
  "first_source_id" TEXT NOT NULL,
  "family_ids_json" JSONB NOT NULL,
  "aliases_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "VaultSource_vault_id_family_id_sha256_key" ON "VaultSource" ("vault_id", "family_id", "sha256");
CREATE UNIQUE INDEX "VaultSourceFamily_vault_id_family_key_key" ON "VaultSourceFamily" ("vault_id", "family_key");
CREATE UNIQUE INDEX "VaultPage_vault_id_page_id_key" ON "VaultPage" ("vault_id", "page_id");
CREATE INDEX "VaultAssertion_vault_id_subject_id_idx" ON "VaultAssertion" ("vault_id", "subject_id");
CREATE INDEX "VaultAssertion_vault_id_predicate_idx" ON "VaultAssertion" ("vault_id", "predicate");
CREATE INDEX "VaultAssertion_vault_id_status_idx" ON "VaultAssertion" ("vault_id", "status");
CREATE INDEX "VaultEvidence_assertion_id_idx" ON "VaultEvidence" ("assertion_id");
CREATE INDEX "VaultEvidence_source_id_idx" ON "VaultEvidence" ("source_id");
CREATE UNIQUE INDEX "VaultRelease_vault_id_revision_key" ON "VaultRelease" ("vault_id", "revision");
CREATE UNIQUE INDEX "VaultEntityCandidate_vault_id_canonical_name_key" ON "VaultEntityCandidate" ("vault_id", "canonical_name");
CREATE INDEX "VaultEntityCandidate_vault_id_status_idx" ON "VaultEntityCandidate" ("vault_id", "status");
ALTER TABLE "VaultSource" ADD FOREIGN KEY ("family_id") REFERENCES "VaultSourceFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultAssertion" ADD FOREIGN KEY ("vault_id", "page_id") REFERENCES "VaultPage"("vault_id", "page_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultEvidence" ADD FOREIGN KEY ("assertion_id") REFERENCES "VaultAssertion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultEvidence" ADD FOREIGN KEY ("source_id") REFERENCES "VaultSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VaultEntityCandidate" ADD FOREIGN KEY ("first_source_id") REFERENCES "VaultSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
