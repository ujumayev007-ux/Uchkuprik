-- Vendor exception to local-network-only operation (additive).
ALTER TABLE "control_policies" ADD COLUMN "network" JSONB;
