-- CreateEnum
CREATE TYPE "PayType" AS ENUM ('NONE', 'HOURLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('BONUS', 'PENALTY', 'ADVANCE');

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "overtimeAfterMinutes" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN     "overtimeMultiplierBp" INTEGER NOT NULL DEFAULT 15000;

-- CreateTable
CREATE TABLE "employee_profiles" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "position" TEXT,
    "payType" "PayType" NOT NULL DEFAULT 'NONE',
    "rate" INTEGER NOT NULL DEFAULT 0,
    "hireDate" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "note" TEXT,
    "correctedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_shifts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "payType" "PayType" NOT NULL,
    "rate" INTEGER NOT NULL,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "baseAmount" INTEGER NOT NULL DEFAULT 0,
    "overtimeAmount" INTEGER NOT NULL DEFAULT 0,
    "bonuses" INTEGER NOT NULL DEFAULT 0,
    "penalties" INTEGER NOT NULL DEFAULT 0,
    "advances" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closed_periods" (
    "tenantId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "closedById" UUID NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closed_periods_pkey" PRIMARY KEY ("tenantId","month")
);

-- CreateIndex
CREATE INDEX "employee_profiles_tenantId_idx" ON "employee_profiles"("tenantId");

-- CreateIndex
CREATE INDEX "attendance_records_tenantId_userId_clockIn_idx" ON "attendance_records"("tenantId", "userId", "clockIn");

-- CreateIndex
CREATE INDEX "attendance_records_tenantId_branchId_clockIn_idx" ON "attendance_records"("tenantId", "branchId", "clockIn");

-- CreateIndex
CREATE INDEX "scheduled_shifts_tenantId_branchId_startsAt_idx" ON "scheduled_shifts"("tenantId", "branchId", "startsAt");

-- CreateIndex
CREATE INDEX "scheduled_shifts_userId_startsAt_idx" ON "scheduled_shifts"("userId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_tenantId_id_key" ON "payroll_periods"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_tenantId_startDate_endDate_key" ON "payroll_periods"("tenantId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_periodId_userId_key" ON "payroll_lines"("periodId", "userId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_tenantId_userId_date_idx" ON "payroll_adjustments"("tenantId", "userId", "date");

-- CreateIndex
CREATE INDEX "expenses_tenantId_branchId_date_idx" ON "expenses"("tenantId", "branchId", "date");

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenantId_periodId_fkey" FOREIGN KEY ("tenantId", "periodId") REFERENCES "payroll_periods"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- HR and finance invariants.
CREATE UNIQUE INDEX "attendance_one_open_per_user" ON "attendance_records" ("userId") WHERE "clockOut" IS NULL;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_order" CHECK ("clockOut" IS NULL OR "clockOut" > "clockIn");
ALTER TABLE "scheduled_shifts" ADD CONSTRAINT "scheduled_shifts_order" CHECK ("endsAt" > "startsAt");
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_rate" CHECK ("rate" >= 0);
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_order" CHECK ("endDate" >= "startDate");
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_amount" CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount" CHECK ("amount" > 0);
ALTER TABLE "closed_periods" ADD CONSTRAINT "closed_periods_month" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_overtime" CHECK ("overtimeAfterMinutes" BETWEEN 60 AND 1440 AND "overtimeMultiplierBp" BETWEEN 10000 AND 30000);
CREATE TRIGGER payroll_adjustments_immutable BEFORE UPDATE OR DELETE ON "payroll_adjustments" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
