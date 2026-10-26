-- Uploaded menu product pictures (additive).
CREATE TABLE IF NOT EXISTS "product_images" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "product_images_tenantId_idx" ON "product_images"("tenantId");
