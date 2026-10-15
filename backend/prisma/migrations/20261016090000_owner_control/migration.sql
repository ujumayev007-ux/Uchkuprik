-- CreateEnum
CREATE TYPE "ControlOwnerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ControlDeviceStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ControlCustomerStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ControlLicenseStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ControlActivationStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'REPLACED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ControlSyncStatus" AS ENUM ('APPLIED', 'DUPLICATE', 'CONFLICT', 'REJECTED');

-- CreateEnum
CREATE TYPE "ControlReleaseStage" AS ENUM ('DRAFT', 'STAGED', 'ALL', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SyncOpStatus" AS ENUM ('PENDING', 'DONE', 'CONFLICT', 'FAILED');

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "lastIp" TEXT,
ADD COLUMN     "panel" TEXT NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "control_owners" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mfaSecretEnc" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "mfaLastStep" BIGINT,
    "status" "ControlOwnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_owner_devices" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "ControlDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_owner_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_owner_sessions" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "reauthAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "control_owner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "note" TEXT,
    "status" "ControlCustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "tenantId" UUID,
    "boundTenantKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_licenses" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "status" "ControlLicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxInstalls" INTEGER NOT NULL DEFAULT 1,
    "maxDevices" INTEGER,
    "maxBranches" INTEGER,
    "maxUsers" INTEGER,
    "features" TEXT[],
    "note" TEXT,
    "renewedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_payments" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "licenseId" UUID,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "method" TEXT NOT NULL DEFAULT 'TRANSFER',
    "periodMonths" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_activations" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "licenseId" UUID NOT NULL,
    "installId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "model" TEXT,
    "os" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'DESKTOP',
    "appVersion" TEXT,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "ControlActivationStatus" NOT NULL DEFAULT 'ACTIVE',
    "branchName" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "currentUser" TEXT,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "pendingCommands" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB,
    "replacedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_terminals" (
    "id" UUID NOT NULL,
    "activationId" UUID NOT NULL,
    "localId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchName" TEXT,
    "panel" TEXT NOT NULL DEFAULT 'OTHER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "appVersion" TEXT,
    "model" TEXT,
    "os" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "currentUser" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_branches" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_policies" (
    "customerId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "features" JSONB NOT NULL DEFAULT '{}',
    "financial" JSONB NOT NULL DEFAULT '{}',
    "offlineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxOfflineMinutes" INTEGER NOT NULL DEFAULT 0,
    "minAppVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "control_policies_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "control_sync_ops" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "activationId" UUID NOT NULL,
    "opId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ControlSyncStatus" NOT NULL,
    "result" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_sync_ops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_releases" (
    "id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER,
    "notes" TEXT,
    "stage" "ControlReleaseStage" NOT NULL DEFAULT 'DRAFT',
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "minVersion" TEXT,
    "signature" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "ownerId" UUID,
    "customerId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
    "data" JSONB,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_link" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "serverUrl" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "licenseHint" TEXT,
    "grant" TEXT NOT NULL,
    "grantIssuedAt" TIMESTAMP(3) NOT NULL,
    "grantExpiresAt" TIMESTAMP(3) NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 0,
    "lastContactAt" TIMESTAMP(3),
    "highWater" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serverStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "requestSeq" BIGINT NOT NULL DEFAULT 0,
    "deviceKeyEnc" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL,
    "opId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "SyncOpStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_settings" (
    "tenantId" UUID NOT NULL,
    "featureKey" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL DEFAULT '*',
    "enabled" BOOLEAN NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_settings_pkey" PRIMARY KEY ("tenantId","featureKey","roleKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "control_owners_email_key" ON "control_owners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "control_owner_devices_fingerprint_key" ON "control_owner_devices"("fingerprint");

-- CreateIndex
CREATE INDEX "control_owner_devices_ownerId_status_idx" ON "control_owner_devices"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "control_owner_sessions_tokenHash_key" ON "control_owner_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "control_owner_sessions_ownerId_revokedAt_idx" ON "control_owner_sessions"("ownerId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "control_customers_tenantId_key" ON "control_customers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "control_licenses_keyHash_key" ON "control_licenses"("keyHash");

-- CreateIndex
CREATE INDEX "control_licenses_customerId_status_idx" ON "control_licenses"("customerId", "status");

-- CreateIndex
CREATE INDEX "control_payments_customerId_paidAt_idx" ON "control_payments"("customerId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "control_activations_fingerprint_key" ON "control_activations"("fingerprint");

-- CreateIndex
CREATE INDEX "control_activations_customerId_status_idx" ON "control_activations"("customerId", "status");

-- CreateIndex
CREATE INDEX "control_activations_licenseId_status_idx" ON "control_activations"("licenseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "control_terminals_activationId_localId_key" ON "control_terminals"("activationId", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "control_branches_customerId_code_key" ON "control_branches"("customerId", "code");

-- CreateIndex
CREATE INDEX "control_sync_ops_customerId_receivedAt_idx" ON "control_sync_ops"("customerId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "control_sync_ops_customerId_opId_key" ON "control_sync_ops"("customerId", "opId");

-- CreateIndex
CREATE UNIQUE INDEX "control_releases_platform_version_key" ON "control_releases"("platform", "version");

-- CreateIndex
CREATE INDEX "control_audit_logs_createdAt_idx" ON "control_audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "control_audit_logs_customerId_createdAt_idx" ON "control_audit_logs"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "control_audit_logs_action_createdAt_idx" ON "control_audit_logs"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_operations_opId_key" ON "sync_operations"("opId");

-- CreateIndex
CREATE INDEX "sync_operations_status_nextAttemptAt_idx" ON "sync_operations"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "control_owner_devices" ADD CONSTRAINT "control_owner_devices_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "control_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_owner_sessions" ADD CONSTRAINT "control_owner_sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "control_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_owner_sessions" ADD CONSTRAINT "control_owner_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "control_owner_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_licenses" ADD CONSTRAINT "control_licenses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_payments" ADD CONSTRAINT "control_payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_payments" ADD CONSTRAINT "control_payments_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "control_licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_activations" ADD CONSTRAINT "control_activations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_activations" ADD CONSTRAINT "control_activations_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "control_licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_terminals" ADD CONSTRAINT "control_terminals_activationId_fkey" FOREIGN KEY ("activationId") REFERENCES "control_activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_branches" ADD CONSTRAINT "control_branches_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_policies" ADD CONSTRAINT "control_policies_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "control_sync_ops" ADD CONSTRAINT "control_sync_ops_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Owner audit evidence is immutable: reject UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION reject_control_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'control_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER control_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "control_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_control_audit_mutation();

CREATE TRIGGER control_audit_logs_no_truncate
  BEFORE TRUNCATE ON "control_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_control_audit_mutation();

-- Defense in depth: a licence never allows fewer than one installation.
ALTER TABLE "control_licenses" ADD CONSTRAINT "control_licenses_limits" CHECK ("maxInstalls" >= 1);
