-- Owner remote management of restaurants (additive only).
CREATE TABLE IF NOT EXISTS "control_remote_ops" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "result" JSONB,
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "control_remote_ops_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "control_remote_ops_customerId_status_idx" ON "control_remote_ops"("customerId", "status");
CREATE INDEX IF NOT EXISTS "control_remote_ops_customerId_kind_doneAt_idx" ON "control_remote_ops"("customerId", "kind", "doneAt");
DO $$ BEGIN
  ALTER TABLE "control_remote_ops" ADD CONSTRAINT "control_remote_ops_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "remote_op_receipts" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "reported" BOOLEAN NOT NULL DEFAULT false,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "remote_op_receipts_pkey" PRIMARY KEY ("id")
);
