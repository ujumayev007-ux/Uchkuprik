-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'IN_REPAIR', 'RETIRED');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RepairPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "ops_tasks" ADD COLUMN     "maintenancePlanId" UUID,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "repairApprovalThreshold" INTEGER NOT NULL DEFAULT 1000000;

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "serialNumber" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "location" TEXT,
    "purchaseDate" DATE,
    "purchaseCost" INTEGER,
    "warrantyUntil" DATE,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "nextDueAt" DATE NOT NULL,
    "lastDoneAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_tickets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "RepairPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "RepairStatus" NOT NULL DEFAULT 'OPEN',
    "reportedById" UUID NOT NULL,
    "technician" TEXT,
    "serviceContractId" UUID,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "laborCost" INTEGER NOT NULL DEFAULT 0,
    "partsCost" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT,
    "downtimeStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "downtimeEnd" TIMESTAMP(3),
    "approvalId" UUID,
    "closedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "cost" INTEGER,
    "passed" BOOLEAN,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_contracts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "vendor" TEXT NOT NULL,
    "phone" TEXT,
    "scope" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT,
    "validityDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "score" INTEGER,
    "evidenceId" UUID,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "amount" INTEGER,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assets_tenantId_branchId_idx" ON "assets"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenantId_tag_key" ON "assets"("tenantId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenantId_id_key" ON "assets"("tenantId", "id");

-- CreateIndex
CREATE INDEX "maintenance_plans_tenantId_isActive_nextDueAt_idx" ON "maintenance_plans"("tenantId", "isActive", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plans_tenantId_id_key" ON "maintenance_plans"("tenantId", "id");

-- CreateIndex
CREATE INDEX "repair_tickets_tenantId_status_idx" ON "repair_tickets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "asset_events_tenantId_assetId_createdAt_idx" ON "asset_events"("tenantId", "assetId", "createdAt");

-- CreateIndex
CREATE INDEX "service_contracts_tenantId_isActive_idx" ON "service_contracts"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_title_key" ON "courses"("tenantId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "courses_tenantId_id_key" ON "courses"("tenantId", "id");

-- CreateIndex
CREATE INDEX "training_records_tenantId_userId_idx" ON "training_records"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "training_records_tenantId_expiresAt_idx" ON "training_records"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "approval_requests_tenantId_status_idx" ON "approval_requests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_entityType_entityId_idx" ON "approval_requests"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_tenantId_maintenancePlanId_fkey" FOREIGN KEY ("tenantId", "maintenancePlanId") REFERENCES "maintenance_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "assets"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "assets"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "assets"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_tenantId_courseId_fkey" FOREIGN KEY ("tenantId", "courseId") REFERENCES "courses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Assets, training and approvals invariants.
ALTER TABLE "assets" ADD CONSTRAINT "assets_tag" CHECK ("tag" ~ '^[A-Z0-9-]{2,30}$' AND ("purchaseCost" IS NULL OR "purchaseCost" >= 0));
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_interval" CHECK ("intervalDays" BETWEEN 1 AND 1825);
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_costs" CHECK ("laborCost" >= 0 AND "partsCost" >= 0 AND ("downtimeEnd" IS NULL OR "downtimeEnd" >= "downtimeStart"));
ALTER TABLE "service_contracts" ADD CONSTRAINT "service_contracts_dates" CHECK ("cost" >= 0 AND ("endDate" IS NULL OR "endDate" >= "startDate"));
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_score" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100);
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_amount" CHECK ("amount" IS NULL OR "amount" >= 0);
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_repair_threshold" CHECK ("repairApprovalThreshold" >= 0);
-- Lifecycle history and certificates are evidence: never edited or deleted.
CREATE TRIGGER "asset_events_append_only" BEFORE UPDATE OR DELETE ON "asset_events" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER "training_records_append_only" BEFORE UPDATE OR DELETE ON "training_records" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
