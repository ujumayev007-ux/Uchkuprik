-- CreateEnum
CREATE TYPE "LoyaltyEntryType" AS ENUM ('EARN', 'REDEEM', 'REVERSAL', 'ADJUST');

-- CreateEnum
CREATE TYPE "CouponKind" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'RESOLVED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'LOYALTY';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "couponId" UUID,
ADD COLUMN     "customerId" UUID;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "loyaltyEarnBp" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "birthday" DATE,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "notes" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,
    "totalSpent" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_entries" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "orderId" UUID,
    "paymentId" UUID,
    "type" "LoyaltyEntryType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "CouponKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "minOrder" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW',
    "resolution" TEXT,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_phone_key" ON "customers"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "loyalty_entries_customerId_id_idx" ON "loyalty_entries"("customerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_tenantId_code_key" ON "coupons"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_tenantId_id_key" ON "coupons"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_orderId_key" ON "feedback"("orderId");

-- CreateIndex
CREATE INDEX "feedback_tenantId_createdAt_idx" ON "feedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_tenantId_customerId_idx" ON "orders"("tenantId", "customerId");

-- AddForeignKey
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Loyalty and coupon invariants.
CREATE TRIGGER loyalty_entries_immutable BEFORE UPDATE OR DELETE ON "loyalty_entries" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE "customers" ADD CONSTRAINT "customers_points" CHECK ("points" >= 0 AND "totalSpent" >= 0 AND "orderCount" >= 0);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_value" CHECK ("value" > 0 AND ("kind" <> 'PERCENT' OR "value" <= 10000) AND "minOrder" >= 0 AND "usedCount" >= 0 AND ("maxUses" IS NULL OR "usedCount" <= "maxUses"));
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_rating" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_loyalty" CHECK ("loyaltyEarnBp" BETWEEN 0 AND 5000);
