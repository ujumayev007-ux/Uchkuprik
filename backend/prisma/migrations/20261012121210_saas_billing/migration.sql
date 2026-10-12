-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "closedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" INTEGER NOT NULL,
    "yearlyPrice" INTEGER NOT NULL,
    "maxBranches" INTEGER,
    "maxUsers" INTEGER,
    "maxDevices" INTEGER,
    "features" TEXT[],
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "suspendedForBilling" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "number" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "planCode" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- CreateIndex
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "invoices_tenantId_createdAt_idx" ON "invoices"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "invoices_status_dueDate_idx" ON "invoices"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_subscriptionId_periodStart_key" ON "invoices"("subscriptionId", "periodStart");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Billing invariants.
ALTER TABLE "plans" ADD CONSTRAINT "plans_amounts" CHECK ("monthlyPrice" >= 0 AND "yearlyPrice" >= 0 AND "trialDays" BETWEEN 0 AND 90
  AND ("maxBranches" IS NULL OR "maxBranches" >= 1) AND ("maxUsers" IS NULL OR "maxUsers" >= 1) AND ("maxDevices" IS NULL OR "maxDevices" >= 0));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amount" CHECK ("amount" >= 0 AND "periodEnd" > "periodStart");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period" CHECK ("currentPeriodEnd" > "currentPeriodStart");

-- Default plans (prices are placeholders the platform administrator can change).
INSERT INTO "plans" ("id", "code", "name", "monthlyPrice", "yearlyPrice", "maxBranches", "maxUsers", "maxDevices", "features", "trialDays", "sortOrder", "updatedAt") VALUES
  (gen_random_uuid(), 'BASIC', 'Basic', 290000, 2900000, 1, 10, 3, ARRAY[]::text[], 14, 1, now()),
  (gen_random_uuid(), 'PRO', 'Pro', 590000, 5900000, 3, 40, 10, ARRAY['inventory','delivery','online_ordering','loyalty','kitchen_printing'], 14, 2, now()),
  (gen_random_uuid(), 'ENTERPRISE', 'Enterprise', 1290000, 12900000, NULL, NULL, NULL, ARRAY['inventory','delivery','online_ordering','loyalty','kitchen_printing','online_payments','hr','finance'], 14, 3, now());
