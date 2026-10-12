-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "courierId" UUID,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryFailReason" TEXT,
ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryProof" TEXT,
ADD COLUMN     "deliveryStatus" "DeliveryStatus",
ADD COLUMN     "deliveryZoneId" UUID,
ADD COLUMN     "pickedUpAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "minOrder" INTEGER NOT NULL DEFAULT 0,
    "etaMinutes" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_profiles" (
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "locationAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_branchId_name_key" ON "delivery_zones"("branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_tenantId_id_key" ON "delivery_zones"("tenantId", "id");

-- CreateIndex
CREATE INDEX "courier_profiles_tenantId_idx" ON "courier_profiles"("tenantId");

-- CreateIndex
CREATE INDEX "orders_tenantId_courierId_deliveryStatus_idx" ON "orders"("tenantId", "courierId", "deliveryStatus");


ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_amounts" CHECK ("fee" >= 0 AND "minOrder" >= 0 AND ("etaMinutes" IS NULL OR "etaMinutes" BETWEEN 1 AND 600));
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_fee" CHECK ("deliveryFee" >= 0);
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_location" CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90) AND ("lng" IS NULL OR "lng" BETWEEN -180 AND 180));
