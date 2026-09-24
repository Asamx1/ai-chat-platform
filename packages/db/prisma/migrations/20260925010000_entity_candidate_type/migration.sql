-- VaultEntityCandidate:同名不同 type 不合并(方案 §4.4)。
-- 原唯一键 [vault_id, canonical_name] 无法保存同名不同类候选,扩为含 type。
DROP INDEX IF EXISTS "VaultEntityCandidate_vaultId_canonicalName_key";
ALTER TABLE "VaultEntityCandidate"
  ADD CONSTRAINT "VaultEntityCandidate_vaultId_canonicalName_type_key"
  UNIQUE ("vault_id", "canonical_name", "type");
