-- Telegram reporting: single-use pairing token, per-recipient money/staff visibility,
-- duplicate-safe queue key, daily report minute, webhook-conflict flag. Additive only:
-- existing recipients keep their chat, events and branches (new flags default to true).

-- AlterTable
ALTER TABLE "notification_jobs" ADD COLUMN     "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "notification_subscribers" ADD COLUMN     "financial" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "linkExpiresAt" TIMESTAMP(3),
ADD COLUMN     "linkTokenHash" TEXT,
ADD COLUMN     "staff" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "telegram_configs" ADD COLUMN     "dailySummaryMinute" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "webhookConflict" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "notification_jobs_subscriberId_dedupeKey_key" ON "notification_jobs"("subscriberId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "notification_subscribers_linkTokenHash_key" ON "notification_subscribers"("linkTokenHash");

