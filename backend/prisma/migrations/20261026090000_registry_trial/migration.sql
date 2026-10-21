-- Central registry: pending registrations, durable Owner events, exact-hour trials (additive).
ALTER TABLE "control_licenses" ADD COLUMN "trialHours" INTEGER;
ALTER TABLE "control_licenses" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

CREATE TYPE "ControlRegistrationStatus" AS ENUM ('PENDING', 'ASSIGNED', 'REJECTED');

CREATE TABLE "control_registrations" (
    "id" UUID NOT NULL,
    "installId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'DESKTOP',
    "appVersion" TEXT,
    "label" TEXT NOT NULL,
    "restaurantName" TEXT,
    "tenantKey" TEXT,
    "installedAt" TIMESTAMP(3),
    "hasLocalLicense" BOOLEAN NOT NULL DEFAULT false,
    "status" "ControlRegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "customerId" UUID,
    "licenseId" UUID,
    "claimKeyEnc" TEXT,
    "lastIp" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "control_registrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "control_registrations_fingerprint_key" ON "control_registrations"("fingerprint");
CREATE INDEX "control_registrations_status_firstSeenAt_idx" ON "control_registrations"("status", "firstSeenAt");
CREATE INDEX "control_registrations_installId_idx" ON "control_registrations"("installId");
CREATE INDEX "control_registrations_tenantKey_idx" ON "control_registrations"("tenantKey");

CREATE TABLE "control_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "customerId" UUID,
    "registrationId" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    CONSTRAINT "control_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "control_events_dedupeKey_key" ON "control_events"("dedupeKey");
CREATE INDEX "control_events_readAt_id_idx" ON "control_events"("readAt", "id");

CREATE TABLE "control_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "control_settings_pkey" PRIMARY KEY ("key")
);
