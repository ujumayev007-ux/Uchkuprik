-- Reliable print queue and printing rules (additive only).
ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'PRINTING';
ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'UNKNOWN';
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "reprintOfId" UUID;
ALTER TABLE "tenant_profiles" ADD COLUMN IF NOT EXISTS "printRules" JSONB;
