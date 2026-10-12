-- CreateEnum
CREATE TYPE "KitchenStatus" AS ENUM ('QUEUED', 'PREPARING', 'READY', 'SERVED');

-- CreateEnum
CREATE TYPE "PrinterKind" AS ENUM ('RECEIPT', 'KITCHEN');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "menu_categories" ADD COLUMN     "stationId" UUID;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "kitchenStatus" "KitchenStatus" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "prepStartedAt" TIMESTAMP(3),
ADD COLUMN     "prepTimeMinutes" INTEGER,
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "stationId" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "readyAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "kitchen_stations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kitchen_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PrinterKind" NOT NULL,
    "stationId" UUID,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "printerId" UUID NOT NULL,
    "orderId" UUID,
    "kind" "PrinterKind" NOT NULL,
    "payload" BYTEA NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_stations_tenantId_id_key" ON "kitchen_stations"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_stations_tenantId_name_key" ON "kitchen_stations"("tenantId", "name");

-- CreateIndex
CREATE INDEX "printers_tenantId_branchId_idx" ON "printers"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "printers_tenantId_id_key" ON "printers"("tenantId", "id");

-- CreateIndex
CREATE INDEX "print_jobs_status_nextTryAt_idx" ON "print_jobs"("status", "nextTryAt");

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenantId_stationId_fkey" FOREIGN KEY ("tenantId", "stationId") REFERENCES "kitchen_stations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "printers" ADD CONSTRAINT "printers_tenantId_stationId_fkey" FOREIGN KEY ("tenantId", "stationId") REFERENCES "kitchen_stations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenantId_printerId_fkey" FOREIGN KEY ("tenantId", "printerId") REFERENCES "printers"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orders" ADD CONSTRAINT "orders_priority" CHECK ("priority" BETWEEN 0 AND 1);
ALTER TABLE "printers" ADD CONSTRAINT "printers_port" CHECK ("port" BETWEEN 1 AND 65535);
CREATE INDEX "order_items_kitchen" ON "order_items" ("tenantId", "kitchenStatus") WHERE "status" = 'ACTIVE';
