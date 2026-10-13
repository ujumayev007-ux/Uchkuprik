-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'QR';

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "qrPayment" JSONB NOT NULL DEFAULT '{}';

