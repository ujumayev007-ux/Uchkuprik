-- Owner sign-in: trusted computers and the one-time recovery key (additive).
ALTER TABLE "control_owner_devices" ADD COLUMN "trustedAt" TIMESTAMP(3);
ALTER TABLE "control_owners" ADD COLUMN "recoveryHash" TEXT;
ALTER TABLE "control_owners" ADD COLUMN "recoveryCreatedAt" TIMESTAMP(3);
