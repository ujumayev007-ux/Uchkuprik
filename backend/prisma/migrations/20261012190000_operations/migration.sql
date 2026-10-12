-- CreateEnum
CREATE TYPE "ChecklistKind" AS ENUM ('OPENING', 'CLOSING', 'CLEANING', 'HACCP', 'OTHER');

-- CreateEnum
CREATE TYPE "ChecklistRunStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'APPROVED');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('FOOD_SAFETY', 'EQUIPMENT', 'INJURY', 'CUSTOMER', 'SECURITY', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskRecurrence" AS ENUM ('NONE', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "OpsTaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED');

-- DropIndex
DROP INDEX "branches_tenantId_franchiseeId_idx";

-- CreateTable
CREATE TABLE "sop_documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sop_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sop_revisions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sopId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sop_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "kind" "ChecklistKind" NOT NULL,
    "items" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "ChecklistRunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "results" JSONB NOT NULL,
    "startedById" UUID NOT NULL,
    "completedById" UUID,
    "completedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checklist_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_files" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "uploadedById" UUID NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "point" TEXT NOT NULL,
    "value" DECIMAL(5,1) NOT NULL,
    "minValue" DECIMAL(5,1) NOT NULL,
    "maxValue" DECIMAL(5,1) NOT NULL,
    "outOfRange" BOOLEAN NOT NULL,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "incidentId" UUID,

    CONSTRAINT "temperature_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "type" "IncidentType" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "reportedById" UUID,
    "rootCause" TEXT,
    "correctiveAction" TEXT,
    "preventiveAction" TEXT,
    "evidenceIds" TEXT[],
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_handovers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "fromUserId" UUID NOT NULL,
    "notes" TEXT NOT NULL,
    "openIssues" TEXT,
    "acknowledgedById" UUID,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_tasks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" UUID,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "recurrence" "TaskRecurrence" NOT NULL DEFAULT 'NONE',
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "status" "OpsTaskStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID NOT NULL,
    "completedById" UUID,
    "completedAt" TIMESTAMP(3),
    "evidenceId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "supplierId" UUID,
    "lotNumber" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" DATE,
    "quantity" DECIMAL(14,3) NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "statusChangedById" UUID,
    "statusChangedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sop_documents_tenantId_category_idx" ON "sop_documents"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "sop_documents_tenantId_id_key" ON "sop_documents"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sop_revisions_sopId_version_key" ON "sop_revisions"("sopId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_templates_tenantId_id_key" ON "checklist_templates"("tenantId", "id");

-- CreateIndex
CREATE INDEX "checklist_runs_tenantId_branchId_businessDate_idx" ON "checklist_runs"("tenantId", "branchId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "checklist_runs_templateId_branchId_businessDate_key" ON "checklist_runs"("templateId", "branchId", "businessDate");

-- CreateIndex
CREATE INDEX "evidence_files_tenantId_createdAt_idx" ON "evidence_files"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "temperature_logs_tenantId_branchId_recordedAt_idx" ON "temperature_logs"("tenantId", "branchId", "recordedAt");

-- CreateIndex
CREATE INDEX "incidents_tenantId_branchId_status_idx" ON "incidents"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "shift_handovers_tenantId_branchId_createdAt_idx" ON "shift_handovers"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "ops_tasks_tenantId_branchId_status_dueAt_idx" ON "ops_tasks"("tenantId", "branchId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "stock_batches_tenantId_status_expiresAt_idx" ON "stock_batches"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "stock_batches_tenantId_stockItemId_lotNumber_idx" ON "stock_batches"("tenantId", "stockItemId", "lotNumber");

-- AddForeignKey
ALTER TABLE "sop_revisions" ADD CONSTRAINT "sop_revisions_tenantId_sopId_fkey" FOREIGN KEY ("tenantId", "sopId") REFERENCES "sop_documents"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "checklist_templates"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_handovers" ADD CONSTRAINT "shift_handovers_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_tenantId_stockItemId_fkey" FOREIGN KEY ("tenantId", "stockItemId") REFERENCES "stock_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Operations invariants.
ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_range" CHECK ("minValue" <= "maxValue" AND "value" BETWEEN -100 AND 400);
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_size" CHECK ("size" > 0 AND "size" <= 2097152 AND "contentType" IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_quantity" CHECK ("quantity" > 0);
-- Compliance records are evidence: never edited or deleted.
CREATE TRIGGER "temperature_logs_append_only" BEFORE UPDATE OR DELETE ON "temperature_logs" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER "sop_revisions_append_only" BEFORE UPDATE OR DELETE ON "sop_revisions" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER "evidence_files_append_only" BEFORE UPDATE OR DELETE ON "evidence_files" FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Operations and food safety are part of the Pro and Enterprise plans.
UPDATE "plans" SET "features" = array_append("features", 'operations'), "updatedAt" = now() WHERE "code" IN ('PRO', 'ENTERPRISE') AND NOT ('operations' = ANY("features"));

-- Front-line roles record checklists, temperatures, tasks and handovers.
UPDATE "roles" SET "permissions" = array_append("permissions", 'operations.perform'), "updatedAt" = now()
WHERE "systemKey" IN ('admin', 'cashier', 'waiter', 'kitchen', 'warehouse') AND NOT ('operations.perform' = ANY("permissions"));
