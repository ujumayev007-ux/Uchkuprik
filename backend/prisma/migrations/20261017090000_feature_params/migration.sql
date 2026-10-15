-- Delegated feature parameters (limits, default modes) set by restaurant Admins.
ALTER TABLE "feature_settings" ALTER COLUMN "enabled" DROP NOT NULL;
ALTER TABLE "feature_settings" ADD COLUMN "params" JSONB;
