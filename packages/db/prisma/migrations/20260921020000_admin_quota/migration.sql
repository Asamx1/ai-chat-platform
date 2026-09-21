BEGIN;
ALTER TABLE "User" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ModelUsageDaily" ADD COLUMN "reservedTokens" INTEGER NOT NULL DEFAULT 0 CHECK ("reservedTokens" >= 0);
ALTER TABLE "ProviderCall" ADD COLUMN "quotaReservation" JSONB;
CREATE TABLE "UserModelQuota" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "modelId" TEXT NOT NULL REFERENCES "ModelRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "dailyLimit" INTEGER NOT NULL CHECK ("dailyLimit" >= 0)
);
CREATE UNIQUE INDEX "UserModelQuota_userId_modelId_key" ON "UserModelQuota"("userId", "modelId");
-- Daily rows lack a provider column. Use provider evidence in the call ledger;
-- never pick an arbitrary provider when that evidence cannot identify one.
CREATE TEMP TABLE day2_usage_map ON COMMIT DROP AS
SELECT d.id, r.id AS target
FROM "ModelUsageDaily" d JOIN "ModelRegistry" r ON r.id = d."modelId"
UNION ALL
SELECT d.id, r.id AS target
FROM "ModelUsageDaily" d JOIN "ModelRegistry" r ON r."modelKey" = d."modelId"
WHERE NOT EXISTS (SELECT 1 FROM "ModelRegistry" exact WHERE exact.id = d."modelId")
AND (
 (SELECT count(*) FROM "ModelRegistry" candidates WHERE candidates."modelKey" = d."modelId") = 1
 OR EXISTS (
  SELECT 1 FROM "UsageLog" u JOIN "ProviderCall" c ON c.id = u."callId"
  JOIN "RunParticipantSnapshot" s ON s.id = c."participantSnapshotId"
  WHERE u."userId" = d."userId" AND (c."startedAt" AT TIME ZONE 'UTC')::date = d.date
   AND s."modelKey" = d."modelId" AND s."providerKey" = r."providerId"
 )
);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "ModelUsageDaily" d LEFT JOIN day2_usage_map m ON m.id=d.id
            GROUP BY d.id HAVING count(m.target) <> 1) THEN
  RAISE EXCEPTION 'Day2: unmapped or ambiguous historical model usage; reconcile provider+modelKey before migration';
 END IF;
END $$;
CREATE TEMP TABLE day2_usage_merged ON COMMIT DROP AS
SELECT min(d.id) AS id, d."userId", m.target AS "modelId", d.date,
 sum(d."tokensIn")::integer AS "tokensIn", sum(d."tokensOut")::integer AS "tokensOut"
FROM "ModelUsageDaily" d JOIN day2_usage_map m ON m.id=d.id
GROUP BY d."userId", m.target, d.date;
DELETE FROM "ModelUsageDaily";
INSERT INTO "ModelUsageDaily" (id,"userId","modelId",date,"tokensIn","tokensOut")
SELECT id,"userId","modelId",date,"tokensIn","tokensOut" FROM day2_usage_merged;
COMMIT;
