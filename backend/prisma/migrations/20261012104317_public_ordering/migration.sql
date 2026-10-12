-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "trackingToken" TEXT;

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "publicOrdering" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "orders_trackingToken_key" ON "orders"("trackingToken");

