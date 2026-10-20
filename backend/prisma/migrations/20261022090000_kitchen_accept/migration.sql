-- Kitchen confirmation (Qabul qilish / Rad etish) on orders (additive).
ALTER TABLE "orders" ADD COLUMN "kitchenAcceptedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "kitchenAcceptedById" UUID;
ALTER TABLE "orders" ADD COLUMN "kitchenRejectedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "kitchenRejectedById" UUID;
ALTER TABLE "orders" ADD COLUMN "kitchenRejectReason" TEXT;
