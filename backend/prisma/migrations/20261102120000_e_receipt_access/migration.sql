-- Electronic receipt access code (additive only): staff-taken orders show their receipt
-- details only with a 6-digit code (in the QR link's #fragment), for 90 days, with a
-- lock after repeated wrong codes. Online orders keep token-only tracking.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receiptCodeEnc" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receiptExpiresAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receiptCodeFails" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receiptLockedUntil" TIMESTAMP(3);
