-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "cardCode" TEXT,
ADD COLUMN     "referralRewardedAt" TIMESTAMP(3),
ADD COLUMN     "referredById" UUID;

-- AlterTable
ALTER TABLE "employee_profiles" ADD COLUMN     "qualityBonus" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "qualityMinRating" DOUBLE PRECISION NOT NULL DEFAULT 4.5;

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_cardCode_key" ON "customers"("tenantId", "cardCode");

