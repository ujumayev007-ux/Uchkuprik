-- CreateEnum
CREATE TYPE "FranchiseeStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID');

-- DropIndex
DROP INDEX "branches_tenantId_brandId_idx";

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "franchiseeId" UUID;

-- CreateTable
CREATE TABLE "franchisees" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" "FranchiseeStatus" NOT NULL DEFAULT 'ONBOARDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "franchisees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_contracts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "franchiseeId" UUID NOT NULL,
    "brandId" UUID,
    "number" TEXT NOT NULL,
    "territory" TEXT NOT NULL,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "royaltyBp" INTEGER NOT NULL,
    "marketingFeeBp" INTEGER NOT NULL DEFAULT 0,
    "minimumMonthlyFee" INTEGER NOT NULL DEFAULT 0,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "activatedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "franchise_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "royalty_statements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "grossSales" INTEGER NOT NULL,
    "refunds" INTEGER NOT NULL,
    "netSales" INTEGER NOT NULL,
    "royalty" INTEGER NOT NULL,
    "marketingFee" INTEGER NOT NULL,
    "minimumTopUp" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "royalty_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "inspectorId" UUID NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL,
    "items" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_agreements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "brandId" UUID,
    "title" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "paymentTermsDays" INTEGER,
    "terms" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "franchisees_tenantId_name_key" ON "franchisees"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "franchisees_tenantId_id_key" ON "franchisees"("tenantId", "id");

-- CreateIndex
CREATE INDEX "franchise_contracts_tenantId_status_idx" ON "franchise_contracts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_contracts_tenantId_number_key" ON "franchise_contracts"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_contracts_tenantId_id_key" ON "franchise_contracts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "royalty_statements_tenantId_month_idx" ON "royalty_statements"("tenantId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "royalty_statements_contractId_month_key" ON "royalty_statements"("contractId", "month");

-- CreateIndex
CREATE INDEX "inspections_tenantId_branchId_inspectedAt_idx" ON "inspections"("tenantId", "branchId", "inspectedAt");

-- CreateIndex
CREATE INDEX "supplier_agreements_tenantId_supplierId_idx" ON "supplier_agreements"("tenantId", "supplierId");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_franchiseeId_fkey" FOREIGN KEY ("tenantId", "franchiseeId") REFERENCES "franchisees"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_contracts" ADD CONSTRAINT "franchise_contracts_tenantId_franchiseeId_fkey" FOREIGN KEY ("tenantId", "franchiseeId") REFERENCES "franchisees"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_contracts" ADD CONSTRAINT "franchise_contracts_tenantId_brandId_fkey" FOREIGN KEY ("tenantId", "brandId") REFERENCES "brands"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_statements" ADD CONSTRAINT "royalty_statements_tenantId_contractId_fkey" FOREIGN KEY ("tenantId", "contractId") REFERENCES "franchise_contracts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_agreements" ADD CONSTRAINT "supplier_agreements_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_agreements" ADD CONSTRAINT "supplier_agreements_tenantId_brandId_fkey" FOREIGN KEY ("tenantId", "brandId") REFERENCES "brands"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Franchise invariants.
ALTER TABLE "franchise_contracts" ADD CONSTRAINT "franchise_contracts_fees" CHECK ("royaltyBp" BETWEEN 0 AND 5000 AND "marketingFeeBp" BETWEEN 0 AND 5000 AND "minimumMonthlyFee" >= 0 AND ("endDate" IS NULL OR "endDate" >= "startDate"));
ALTER TABLE "royalty_statements" ADD CONSTRAINT "royalty_statements_month" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$' AND "total" >= 0 AND "netSales" >= 0);
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_score" CHECK ("score" BETWEEN 0 AND 100);
ALTER TABLE "supplier_agreements" ADD CONSTRAINT "supplier_agreements_dates" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
CREATE INDEX "branches_tenantId_franchiseeId_idx" ON "branches" ("tenantId", "franchiseeId");
-- Inspection records are evidence: never edited or deleted.
CREATE TRIGGER "inspections_append_only" BEFORE UPDATE OR DELETE ON "inspections" FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Franchise management is an Enterprise feature by default.
UPDATE "plans" SET "features" = array_append("features", 'franchise'), "updatedAt" = now() WHERE "code" = 'ENTERPRISE' AND NOT ('franchise' = ANY("features"));

-- Seed the franchisee system role for existing business tenants.
INSERT INTO "roles" ("id", "tenantId", "systemKey", "name", "description", "permissions", "updatedAt")
SELECT gen_random_uuid(), t."id", 'franchisee', 'Franchayzi', 'Franchayzi portali: o‘z filiallari, shartnoma va hisob-kitoblar', ARRAY['franchise.portal', 'reports.view', 'branches.view'], now()
FROM "tenants" t
WHERE t."kind" = 'BUSINESS'
  AND NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."tenantId" = t."id" AND r."systemKey" = 'franchisee')
  AND NOT EXISTS (SELECT 1 FROM "roles" r WHERE r."tenantId" = t."id" AND r."name" = 'Franchayzi');
