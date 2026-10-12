-- CreateEnum
CREATE TYPE "BaseUnit" AS ENUM ('G', 'ML', 'PCS');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'SALE', 'WASTE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'STOCKTAKE');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'RECEIVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "allowNegativeStock" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "baseUnit" "BaseUnit" NOT NULL,
    "minStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_units" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "stock_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "tenantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("warehouseId","stockItemId")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "balanceAfter" DECIMAL(14,3) NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "taxId" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceNo" TEXT,
    "note" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitName" TEXT NOT NULL,
    "factor" DECIMAL(14,3) NOT NULL,
    "baseQuantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,

    CONSTRAINT "purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_lines" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "recipe_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenantId_id_key" ON "stock_items"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenantId_name_key" ON "stock_items"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenantId_sku_key" ON "stock_items"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "stock_units_stockItemId_name_key" ON "stock_units"("stockItemId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_tenantId_id_key" ON "warehouses"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_branchId_name_key" ON "warehouses"("branchId", "name");

-- CreateIndex
CREATE INDEX "stock_balances_tenantId_stockItemId_idx" ON "stock_balances"("tenantId", "stockItemId");

-- CreateIndex
CREATE INDEX "stock_movements_tenantId_warehouseId_createdAt_idx" ON "stock_movements"("tenantId", "warehouseId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_stockItemId_createdAt_idx" ON "stock_movements"("stockItemId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_referenceType_referenceId_idx" ON "stock_movements"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_id_key" ON "suppliers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenantId_name_key" ON "suppliers"("tenantId", "name");

-- CreateIndex
CREATE INDEX "purchases_tenantId_createdAt_idx" ON "purchases"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_tenantId_id_key" ON "purchases"("tenantId", "id");

-- CreateIndex
CREATE INDEX "purchase_lines_purchaseId_idx" ON "purchase_lines"("purchaseId");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_idx" ON "supplier_payments"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_lines_variantId_stockItemId_key" ON "recipe_lines"("variantId", "stockItemId");

-- AddForeignKey
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_tenantId_stockItemId_fkey" FOREIGN KEY ("tenantId", "stockItemId") REFERENCES "stock_items"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenantId_stockItemId_fkey" FOREIGN KEY ("tenantId", "stockItemId") REFERENCES "stock_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_stockItemId_fkey" FOREIGN KEY ("tenantId", "stockItemId") REFERENCES "stock_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_tenantId_purchaseId_fkey" FOREIGN KEY ("tenantId", "purchaseId") REFERENCES "purchases"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "product_variants"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_tenantId_stockItemId_fkey" FOREIGN KEY ("tenantId", "stockItemId") REFERENCES "stock_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Inventory invariants.
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER supplier_payments_immutable BEFORE UPDATE OR DELETE ON "supplier_payments" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE UNIQUE INDEX "warehouses_one_default_per_branch" ON "warehouses" ("branchId") WHERE "isDefault";
ALTER TABLE "stock_units" ADD CONSTRAINT "stock_units_factor" CHECK ("factor" > 0);
ALTER TABLE "recipe_lines" ADD CONSTRAINT "recipe_lines_quantity" CHECK ("quantity" > 0);
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_amounts" CHECK ("quantity" > 0 AND "factor" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_amount" CHECK ("amount" > 0);
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_min_stock" CHECK ("minStock" >= 0);
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_cost" CHECK ("avgCost" >= 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity" CHECK ("quantity" <> 0 AND "unitCost" >= 0);
