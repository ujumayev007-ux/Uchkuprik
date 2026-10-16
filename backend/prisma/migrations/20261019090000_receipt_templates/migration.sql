-- Named receipt/ticket templates and their assignments (additive).
CREATE TABLE "receipt_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "receipt_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receipt_assignments" (
    "tenantId" UUID NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "templateId" UUID NOT NULL,
    CONSTRAINT "receipt_assignments_pkey" PRIMARY KEY ("tenantId","targetType","targetId")
);

CREATE UNIQUE INDEX "receipt_templates_tenantId_id_key" ON "receipt_templates"("tenantId", "id");
CREATE UNIQUE INDEX "receipt_templates_tenantId_name_key" ON "receipt_templates"("tenantId", "name");
CREATE INDEX "receipt_assignments_tenantId_templateId_idx" ON "receipt_assignments"("tenantId", "templateId");

ALTER TABLE "receipt_assignments" ADD CONSTRAINT "receipt_assignments_tenantId_templateId_fkey"
  FOREIGN KEY ("tenantId", "templateId") REFERENCES "receipt_templates"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
