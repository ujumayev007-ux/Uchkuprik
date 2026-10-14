-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "attachmentId" UUID,
ADD COLUMN     "fromCash" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recipient" TEXT;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "expenseApprovalLimit" INTEGER;
