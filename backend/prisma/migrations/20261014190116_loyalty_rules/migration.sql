-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "loyaltyRules" JSONB NOT NULL DEFAULT '{}';
