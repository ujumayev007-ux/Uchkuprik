-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryDistanceM" INTEGER,
ADD COLUMN     "deliveryLat" DOUBLE PRECISION,
ADD COLUMN     "deliveryLng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "deliveryPricing" JSONB NOT NULL DEFAULT '{}';
