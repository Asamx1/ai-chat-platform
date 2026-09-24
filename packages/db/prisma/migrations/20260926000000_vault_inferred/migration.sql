-- Only the separate machine-inferred assertion table is introduced.
CREATE TABLE "VaultInferredAssertion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vault_id" TEXT NOT NULL DEFAULT 'default',
  "subject_id" TEXT NOT NULL,
  "predicate" TEXT NOT NULL,
  "object_id" TEXT,
  "value" TEXT,
  "polarity" BOOLEAN NOT NULL,
  "conditions" TEXT,
  "derived_from_json" JSONB NOT NULL,
  "rule_version" TEXT NOT NULL,
  "ontology_version" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'machine',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "VaultInferredAssertion_edge_key"
  ON "VaultInferredAssertion" ("vault_id", "subject_id", "predicate", "object_id");
CREATE INDEX "VaultInferredAssertion_vault_id_idx" ON "VaultInferredAssertion" ("vault_id");
