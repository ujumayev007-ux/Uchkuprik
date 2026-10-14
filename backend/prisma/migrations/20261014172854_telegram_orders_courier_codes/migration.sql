-- CreateEnum
CREATE TYPE "OrderCodePurpose" AS ENUM ('PICKUP', 'HANDOFF', 'DELIVERY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeliveryStatus" ADD VALUE 'ON_THE_WAY';
ALTER TYPE "DeliveryStatus" ADD VALUE 'RETURNED';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cashCollected" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cashReconciledAt" TIMESTAMP(3),
ADD COLUMN     "cashReconciledById" UUID,
ADD COLUMN     "handedOverById" UUID,
ADD COLUMN     "onTheWayAt" TIMESTAMP(3),
ADD COLUMN     "telegramChatId" TEXT,
ADD COLUMN     "telegramNotified" TEXT;

-- AlterTable
ALTER TABLE "telegram_configs" ADD COLUMN     "orderBranchId" UUID,
ADD COLUMN     "ordersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updateOffset" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "order_codes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "purpose" "OrderCodePurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_chats" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "chatId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "state" JSONB NOT NULL DEFAULT '{}',
    "lastOrderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_chats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_codes_orderId_purpose_idx" ON "order_codes"("orderId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_chats_tenantId_chatId_key" ON "telegram_chats"("tenantId", "chatId");
