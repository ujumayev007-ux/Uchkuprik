-- Central off-device copies of restaurant backups (additive only). The restaurant
-- encrypts each copy with its own password before upload; the centre stores bytes it
-- cannot read, in chunks, and keeps the newest few per customer.
CREATE TABLE IF NOT EXISTS "control_backup_uploads" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "activationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "chunks" INTEGER NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RECEIVING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "control_backup_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "control_backup_uploads_customerId_status_createdAt_idx" ON "control_backup_uploads"("customerId", "status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "control_backup_uploads_customerId_sha256_key" ON "control_backup_uploads"("customerId", "sha256");
DO $$ BEGIN
  ALTER TABLE "control_backup_uploads" ADD CONSTRAINT "control_backup_uploads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "control_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "control_backup_chunks" (
    "uploadId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    CONSTRAINT "control_backup_chunks_pkey" PRIMARY KEY ("uploadId", "index")
);
DO $$ BEGIN
  ALTER TABLE "control_backup_chunks" ADD CONSTRAINT "control_backup_chunks_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "control_backup_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
