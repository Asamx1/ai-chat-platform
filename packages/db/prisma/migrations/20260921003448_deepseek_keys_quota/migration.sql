-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "provider" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "providerId" DROP NOT NULL,
ALTER COLUMN "iv" DROP NOT NULL,
ALTER COLUMN "authTag" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ModelRegistry" ADD COLUMN     "adapter" TEXT,
ADD COLUMN     "baseUrl" TEXT,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'local';

-- CreateTable
CREATE TABLE "ModelUsageDaily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModelUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelUsageDaily_userId_modelId_date_key" ON "ModelUsageDaily"("userId", "modelId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_userId_provider_key" ON "ApiKey"("userId", "provider");

-- AddForeignKey
ALTER TABLE "ModelUsageDaily" ADD CONSTRAINT "ModelUsageDaily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

