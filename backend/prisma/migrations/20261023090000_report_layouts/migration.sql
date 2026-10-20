-- Per-restaurant report layout (sections and columns shown); additive.
CREATE TABLE "report_layouts" (
    "tenantId" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "report_layouts_pkey" PRIMARY KEY ("tenantId")
);
