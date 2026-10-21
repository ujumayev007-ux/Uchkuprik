-- Inventory alerts (additive).
CREATE TYPE "StockAlertSeverity" AS ENUM ('LOW', 'CRITICAL', 'OUT');
CREATE TYPE "StockAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE "stock_alerts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "stockItemId" UUID NOT NULL,
    "severity" "StockAlertSeverity" NOT NULL,
    "status" "StockAlertStatus" NOT NULL DEFAULT 'OPEN',
    "quantity" DECIMAL(14,3) NOT NULL,
    "threshold" DECIMAL(14,3) NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "stock_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stock_alerts_tenantId_status_idx" ON "stock_alerts"("tenantId", "status");
CREATE INDEX "stock_alerts_stockItemId_openedAt_idx" ON "stock_alerts"("stockItemId", "openedAt");
-- At most one active alert per item and warehouse, however many updates race.
CREATE UNIQUE INDEX "stock_alerts_one_active" ON "stock_alerts" ("warehouseId", "stockItemId") WHERE "status" <> 'RESOLVED';

CREATE TABLE "stock_alert_settings" (
    "tenantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "soundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "criticalPercent" INTEGER NOT NULL DEFAULT 50,
    "reminderMinutes" INTEGER NOT NULL DEFAULT 10,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stock_alert_settings_pkey" PRIMARY KEY ("tenantId")
);
