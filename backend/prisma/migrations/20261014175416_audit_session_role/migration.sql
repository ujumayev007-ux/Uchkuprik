-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "roles" TEXT,
ADD COLUMN     "sessionId" UUID;

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_entityId_idx" ON "audit_logs"("tenantId", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_actorUserId_createdAt_idx" ON "audit_logs"("tenantId", "actorUserId", "createdAt");
