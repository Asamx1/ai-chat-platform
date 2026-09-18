-- AlterTable
ALTER TABLE "OrchestrationRun" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseOwner" TEXT;
