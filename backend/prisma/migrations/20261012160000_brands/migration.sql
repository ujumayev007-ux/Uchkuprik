-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "brandId" UUID;

-- AlterTable
ALTER TABLE "menu_categories" ADD COLUMN     "brandId" UUID;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "receiptHeader" TEXT,
    "receiptFooter" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenantId_code_key" ON "brands"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "brands_tenantId_id_key" ON "brands"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_brandId_fkey" FOREIGN KEY ("tenantId", "brandId") REFERENCES "brands"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenantId_brandId_fkey" FOREIGN KEY ("tenantId", "brandId") REFERENCES "brands"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Brand invariants.
ALTER TABLE "brands" ADD CONSTRAINT "brands_code" CHECK ("code" ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$');
ALTER TABLE "brands" ADD CONSTRAINT "brands_color" CHECK ("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9a-fA-F]{6}$');
CREATE INDEX "branches_tenantId_brandId_idx" ON "branches" ("tenantId", "brandId");
