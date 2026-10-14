-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "cancelPrintedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "print_jobs" ADD COLUMN     "fallbackFromId" UUID,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'NEW';

-- AlterTable
ALTER TABLE "printers" ADD COLUMN     "fallbackPrinterId" UUID;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "orderSettings" JSONB NOT NULL DEFAULT '{}';
