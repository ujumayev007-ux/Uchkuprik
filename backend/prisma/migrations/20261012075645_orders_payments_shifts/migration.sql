-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('POS', 'WAITER', 'QR', 'WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PLACED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'CLICK', 'PAYME', 'UZUM', 'OTHER');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "cash_shifts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "registerKey" TEXT NOT NULL,
    "deviceId" UUID,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingCash" INTEGER NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "expectedCash" INTEGER,
    "countedCash" INTEGER,
    "variance" INTEGER,
    "closeNote" TEXT,

    CONSTRAINT "cash_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_counters" (
    "branchId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_counters_pkey" PRIMARY KEY ("branchId","businessDate")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "businessDate" DATE NOT NULL,
    "type" "OrderType" NOT NULL,
    "channel" "OrderChannel" NOT NULL DEFAULT 'POS',
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "tableId" UUID,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "deliveryAddress" TEXT,
    "note" TEXT,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "discountTotal" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "serviceChargeBp" INTEGER NOT NULL DEFAULT 0,
    "serviceCharge" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "paidTotal" INTEGER NOT NULL DEFAULT 0,
    "refundedTotal" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "placedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "variantName" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "unitCost" INTEGER,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "modifiersTotal" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "note" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shiftId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "tendered" INTEGER,
    "change" INTEGER,
    "reference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "shiftId" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_shifts_tenantId_branchId_openedAt_idx" ON "cash_shifts"("tenantId", "branchId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cash_shifts_tenantId_id_key" ON "cash_shifts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "cash_movements_shiftId_idx" ON "cash_movements"("shiftId");

-- CreateIndex
CREATE INDEX "orders_tenantId_branchId_status_idx" ON "orders"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "orders_tenantId_branchId_createdAt_idx" ON "orders"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenantId_id_key" ON "orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenantId_idempotencyKey_key" ON "orders"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "orders_branchId_businessDate_number_key" ON "orders"("branchId", "businessDate", "number");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_tenantId_variantId_idx" ON "order_items"("tenantId", "variantId");

-- CreateIndex
CREATE INDEX "order_events_orderId_id_idx" ON "order_events"("orderId", "id");

-- CreateIndex
CREATE INDEX "payments_orderId_idx" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_shiftId_idx" ON "payments"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_id_key" ON "payments"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_idempotencyKey_key" ON "payments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- CreateIndex
CREATE INDEX "refunds_shiftId_idx" ON "refunds"("shiftId");

-- AddForeignKey
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "cash_shifts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "product_variants"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One open shift per cash register.
CREATE UNIQUE INDEX "cash_shifts_one_open_per_register" ON "cash_shifts" ("branchId", "registerKey") WHERE "status" = 'OPEN';

-- Financial invariants.
ALTER TABLE "cash_shifts" ADD CONSTRAINT "cash_shifts_amounts" CHECK ("openingCash" >= 0 AND ("countedCash" IS NULL OR "countedCash" >= 0));
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount" CHECK ("amount" <> 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts" CHECK ("quantity" BETWEEN 1 AND 999 AND "unitPrice" >= 0 AND "modifiersTotal" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts" CHECK (
  "subtotal" >= 0 AND "discountTotal" >= 0 AND "discountTotal" <= "subtotal" AND "serviceCharge" >= 0
  AND "total" >= 0 AND "paidTotal" >= 0 AND "refundedTotal" >= 0 AND "refundedTotal" <= "paidTotal"
  AND "paidTotal" - "refundedTotal" <= "total"
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts" CHECK (
  "amount" > 0 AND ("tendered" IS NULL OR "tendered" >= "amount") AND ("change" IS NULL OR "change" >= 0)
);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount" CHECK ("amount" > 0);

-- Payments, refunds, cash movements and order events are immutable records.
CREATE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER refunds_immutable BEFORE UPDATE OR DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON "cash_movements" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON "order_events" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
