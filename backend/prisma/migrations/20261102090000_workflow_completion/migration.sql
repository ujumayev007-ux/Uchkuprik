-- Workflow completion (additive only): customer credit and hotel room accounts,
-- scheduled orders and banquets, receipt type of a kitchen department.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CREDIT';

DO $$ BEGIN
  CREATE TYPE "CreditAccountKind" AS ENUM ('CUSTOMER', 'HOTEL_ROOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CreditEntryType" AS ENUM ('CHARGE', 'REPAYMENT', 'REFUND', 'ADJUSTMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "credit_accounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "CreditAccountKind" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "room" TEXT,
    "customerId" UUID,
    "creditLimit" INTEGER,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "checkoutAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_accounts_tenantId_id_key" ON "credit_accounts"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "credit_accounts_tenantId_isOpen_idx" ON "credit_accounts"("tenantId", "isOpen");

CREATE TABLE IF NOT EXISTS "credit_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" "CreditEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "orderId" UUID,
    "paymentId" UUID,
    "method" TEXT,
    "shiftId" UUID,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "credit_entries_accountId_createdAt_idx" ON "credit_entries"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "credit_entries_paymentId_idx" ON "credit_entries"("paymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_entries_tenantId_idempotencyKey_key" ON "credit_entries"("tenantId", "idempotencyKey");
DO $$ BEGIN
  ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "credit_accounts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Scheduled orders and banquets: prepared for a time; the kitchen gets them when due.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "scheduleConfirmedAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "guests" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eventName" TEXT;
CREATE INDEX IF NOT EXISTS "orders_tenantId_status_scheduledFor_idx" ON "orders"("tenantId", "status", "scheduledFor");

-- Which printing rule a kitchen department's tickets follow (KITCHEN / KEBAB / BAR).
ALTER TABLE "kitchen_stations" ADD COLUMN IF NOT EXISTS "printType" TEXT NOT NULL DEFAULT 'KITCHEN';
