-- Owner device management (additive only).
ALTER TYPE "ControlActivationStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TABLE "control_activations" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "control_activations" ADD COLUMN IF NOT EXISTS "hostname" TEXT;
ALTER TABLE "control_activations" ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "control_activations" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "control_activations" ADD COLUMN IF NOT EXISTS "hostRename" JSONB;
ALTER TABLE "control_link" ADD COLUMN IF NOT EXISTS "hostRenameRequest" JSONB;
