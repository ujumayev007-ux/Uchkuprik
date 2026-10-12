-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYME', 'CLICK');

-- CreateEnum
CREATE TYPE "ProviderTxState" AS ENUM ('CREATED', 'PERFORMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'REGISTERED', 'FAILED');

-- CreateTable
CREATE TABLE "payment_provider_configs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "merchantId" TEXT NOT NULL,
    "serviceId" TEXT,
    "merchantUserId" TEXT,
    "secretEnc" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_transactions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" "ProviderTxState" NOT NULL DEFAULT 'CREATED',
    "providerTime" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" INTEGER,
    "paymentId" UUID,

    CONSTRAINT "provider_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_receipts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "FiscalStatus" NOT NULL,
    "provider" TEXT,
    "fiscalSign" TEXT,
    "qrUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_configs_tenantId_provider_key" ON "payment_provider_configs"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_configs_tenantId_id_key" ON "payment_provider_configs"("tenantId", "id");

-- CreateIndex
CREATE INDEX "provider_transactions_tenantId_createdAt_idx" ON "provider_transactions"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "provider_transactions_orderId_idx" ON "provider_transactions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_transactions_provider_externalId_key" ON "provider_transactions"("provider", "externalId");

-- CreateIndex
CREATE INDEX "fiscal_receipts_tenantId_status_idx" ON "fiscal_receipts"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_receipts_orderId_key" ON "fiscal_receipts"("orderId");

-- AddForeignKey
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_tenantId_configId_fkey" FOREIGN KEY ("tenantId", "configId") REFERENCES "payment_provider_configs"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Provider amounts are positive whole so'm.
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_amount" CHECK ("amount" > 0);
