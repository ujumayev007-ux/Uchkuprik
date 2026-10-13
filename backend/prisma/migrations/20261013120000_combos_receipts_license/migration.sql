-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "components" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "tenant_profiles" ADD COLUMN     "receiptSettings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "combo_components" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "componentVariantId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_license" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "key" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_license_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "combo_components_tenantId_variantId_idx" ON "combo_components"("tenantId", "variantId");


ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_quantity" CHECK ("quantity" BETWEEN 1 AND 50);
ALTER TABLE "app_license" ADD CONSTRAINT "app_license_single_row" CHECK ("id" = 1);
