-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "telegram_configs" (
    "tenantId" UUID NOT NULL,
    "botTokenEnc" TEXT NOT NULL,
    "botUsername" TEXT,
    "webhookSecretHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dailySummaryHour" INTEGER DEFAULT 22,
    "lastDailySummary" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_configs_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "notification_subscribers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "chatId" TEXT,
    "linkCode" TEXT,
    "events" TEXT[],
    "branchIds" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "tenantId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("tenantId","event")
);

-- CreateTable
CREATE TABLE "notification_jobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriberId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextTryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_subscribers_linkCode_key" ON "notification_subscribers"("linkCode");

-- CreateIndex
CREATE UNIQUE INDEX "notification_subscribers_tenantId_id_key" ON "notification_subscribers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_subscribers_tenantId_chatId_key" ON "notification_subscribers"("tenantId", "chatId");

-- CreateIndex
CREATE INDEX "notification_jobs_status_nextTryAt_idx" ON "notification_jobs"("status", "nextTryAt");

-- CreateIndex
CREATE INDEX "notification_jobs_tenantId_createdAt_idx" ON "notification_jobs"("tenantId", "createdAt");


-- Notification invariants.
ALTER TABLE "telegram_configs" ADD CONSTRAINT "telegram_configs_hour" CHECK ("dailySummaryHour" IS NULL OR "dailySummaryHour" BETWEEN 0 AND 23);
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_attempts" CHECK ("attempts" >= 0);
