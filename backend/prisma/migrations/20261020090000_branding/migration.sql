-- Central advertising and remote design management (additive).
CREATE TABLE "branding_media" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "branding_media_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "branding_media_sha256_idx" ON "branding_media"("sha256");

CREATE TABLE "branding_designs" (
    "key" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,
    CONSTRAINT "branding_designs_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "tenant_designs" (
    "tenantId" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,
    CONSTRAINT "tenant_designs_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE "ad_campaigns" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "text" TEXT,
    "mediaId" UUID,
    "panels" TEXT[],
    "targetMode" TEXT NOT NULL DEFAULT 'ALL',
    "durationSec" INTEGER NOT NULL DEFAULT 10,
    "closable" BOOLEAN NOT NULL DEFAULT true,
    "autoCloseSec" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "everyMinutes" INTEGER NOT NULL DEFAULT 0,
    "maxPerDay" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns"("status");

CREATE TABLE "ad_targets" (
    "campaignId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    CONSTRAINT "ad_targets_pkey" PRIMARY KEY ("campaignId","customerId")
);
CREATE INDEX "ad_targets_customerId_idx" ON "ad_targets"("customerId");
ALTER TABLE "ad_targets" ADD CONSTRAINT "ad_targets_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ad_stats" (
    "campaignId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "panel" TEXT NOT NULL,
    "shown" INTEGER NOT NULL DEFAULT 0,
    "closed" INTEGER NOT NULL DEFAULT 0,
    "shownSent" INTEGER NOT NULL DEFAULT 0,
    "closedSent" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ad_stats_pkey" PRIMARY KEY ("campaignId","customerId","day","panel")
);

CREATE TABLE "ad_deliveries" (
    "campaignId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "activationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    CONSTRAINT "ad_deliveries_pkey" PRIMARY KEY ("campaignId","activationId")
);
CREATE INDEX "ad_deliveries_customerId_idx" ON "ad_deliveries"("customerId");

CREATE TABLE "branding_cache" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" TEXT NOT NULL,
    "bundle" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "branding_cache_pkey" PRIMARY KEY ("id")
);
