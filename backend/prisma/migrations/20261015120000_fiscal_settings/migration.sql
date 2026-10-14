-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "fiscalCredentialsEnc" TEXT,
ADD COLUMN     "fiscalSettings" JSONB NOT NULL DEFAULT '{}';

