-- Receipt designer: saved versions of every receipt template (additive only).
-- templateId NULL = the restaurant's default receipt (tenant_profiles.receiptSettings).
CREATE TABLE IF NOT EXISTS "receipt_template_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "settings" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipt_template_versions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "receipt_template_versions_tenantId_templateId_createdAt_idx" ON "receipt_template_versions"("tenantId", "templateId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "receipt_template_versions" ADD CONSTRAINT "receipt_template_versions_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "receipt_templates"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
