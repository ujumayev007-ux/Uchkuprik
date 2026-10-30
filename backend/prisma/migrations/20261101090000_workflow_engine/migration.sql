-- Restaurant workflow engine (additive only; existing behaviour unchanged).
ALTER TABLE "tenant_profiles" ADD COLUMN IF NOT EXISTS "workflow" JSONB;
ALTER TABLE "tenant_profiles" ADD COLUMN IF NOT EXISTS "workflowVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'HALL';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "workflow" JSONB;
CREATE TABLE IF NOT EXISTS "control_workflows" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "control_workflows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "control_workflows_customerId_version_key" ON "control_workflows"("customerId", "version");
DO $$ BEGIN
  ALTER TABLE "control_workflows" ADD CONSTRAINT "control_workflows_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
