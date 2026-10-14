-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdjustmentType" ADD VALUE 'LOAN';
ALTER TYPE "AdjustmentType" ADD VALUE 'REPAYMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayType" ADD VALUE 'DAILY';
ALTER TYPE "PayType" ADD VALUE 'SHIFT';

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "perCustomer" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "perOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "salesPercentBp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payroll_adjustments" ADD COLUMN     "fromCash" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payroll_lines" ADD COLUMN     "commission" INTEGER NOT NULL DEFAULT 0;
