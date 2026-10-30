-- Electronic receipts sent by the restaurant's Telegram bot (additive only; off by
-- default). Receipts go only to chats whose phone Telegram confirmed as the user's own.
ALTER TABLE "telegram_configs" ADD COLUMN IF NOT EXISTS "receiptsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telegram_chats" ADD COLUMN IF NOT EXISTS "phoneVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "telegramReceiptAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "telegram_chats_tenantId_phone_idx" ON "telegram_chats"("tenantId", "phone");
