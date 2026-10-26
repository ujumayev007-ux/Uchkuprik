-- The terminal each work shift was opened on (additive; older rows stay null).
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "deviceId" UUID;
