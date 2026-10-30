-- Scheduled-order release worker (every 30 s, all restaurants): only confirmed
-- bookings are indexed, so the check stays cheap on large order tables (additive).
CREATE INDEX IF NOT EXISTS "orders_scheduled_release_idx" ON "orders"("scheduledFor") WHERE "status" = 'PENDING' AND "scheduleConfirmedAt" IS NOT NULL;
