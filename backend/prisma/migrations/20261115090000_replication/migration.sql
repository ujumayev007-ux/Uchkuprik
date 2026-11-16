-- Two-way replication (Kassa server <-> central server). Additive only: new columns
-- with defaults and new tables; no existing data is changed. Triggers are installed
-- by the application only for tenants that are attached (replication_tenants).

-- AlterTable
ALTER TABLE "loyalty_entries" ADD COLUMN     "uid" UUID NOT NULL DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "order_events" ADD COLUMN     "uid" UUID NOT NULL DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "uid" UUID NOT NULL DEFAULT gen_random_uuid();

-- CreateTable
CREATE TABLE "replication_tenants" (
    "tenantId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "customerId" UUID,
    "nodeId" TEXT NOT NULL,
    "pinKeyEnc" TEXT,
    "pushedSeq" BIGINT NOT NULL DEFAULT 0,
    "pulledSeq" BIGINT NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replication_tenants_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "replication_changes" (
    "seq" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "tbl" TEXT NOT NULL,
    "pk" JSONB NOT NULL,
    "op" TEXT NOT NULL,
    "row" JSONB,
    "delta" JSONB,
    "changedAt" TIMESTAMPTZ(6) NOT NULL,
    "origin" TEXT NOT NULL,

    CONSTRAINT "replication_changes_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "replication_rows" (
    "tbl" TEXT NOT NULL,
    "pk" TEXT NOT NULL,
    "changedAt" TIMESTAMPTZ(6) NOT NULL,
    "origin" TEXT NOT NULL,

    CONSTRAINT "replication_rows_pkey" PRIMARY KEY ("tbl","pk")
);

-- CreateTable
CREATE TABLE "replication_peers" (
    "origin" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "appliedSeq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "replication_peers_pkey" PRIMARY KEY ("origin","tenantId")
);

-- CreateTable
CREATE TABLE "replication_conflicts" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "tbl" TEXT NOT NULL,
    "pk" JSONB NOT NULL,
    "op" TEXT NOT NULL,
    "row" JSONB,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "replication_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replication_parked" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "change" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replication_parked_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "replication_changes_tenantId_seq_idx" ON "replication_changes"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "replication_changes_changedAt_idx" ON "replication_changes"("changedAt");

-- CreateIndex
CREATE INDEX "replication_conflicts_tenantId_createdAt_idx" ON "replication_conflicts"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "replication_parked_tenantId_id_idx" ON "replication_parked"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_entries_uid_key" ON "loyalty_entries"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "order_events_uid_key" ON "order_events"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_uid_key" ON "stock_movements"("uid");


-- Capture trigger. Arguments: primary key columns, excluded columns (server-bound
-- secrets), additive columns (counters: their change is sent as a delta), all
-- comma-separated. Changes made while applying the other side's changes
-- (ff.applying = on) are not captured, so nothing is echoed back.
CREATE OR REPLACE FUNCTION ff_replicate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb;
  old_rec jsonb;
  tid uuid;
  node text;
  pkv jsonb := '{}'::jsonb;
  col text;
  delta jsonb := NULL;
  pkcols text[] := string_to_array(TG_ARGV[0], ',');
  excluded text[] := CASE WHEN TG_ARGV[1] = '' THEN '{}'::text[] ELSE string_to_array(TG_ARGV[1], ',') END;
  additive text[] := CASE WHEN TG_ARGV[2] = '' THEN '{}'::text[] ELSE string_to_array(TG_ARGV[2], ',') END;
  at timestamptz := clock_timestamp();
BEGIN
  IF coalesce(current_setting('ff.applying', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    tid := (rec->>'id')::uuid;
  ELSE
    tid := (rec->>'tenantId')::uuid;
  END IF;
  SELECT "nodeId" INTO node FROM replication_tenants WHERE "tenantId" = tid;
  IF node IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH col IN ARRAY pkcols LOOP
    pkv := pkv || jsonb_build_object(col, rec->col);
  END LOOP;
  IF TG_OP = 'UPDATE' THEN
    old_rec := to_jsonb(OLD);
    -- Only server-bound columns changed: nothing to send.
    IF (rec - excluded) = (old_rec - excluded) THEN
      RETURN NULL;
    END IF;
    IF array_length(additive, 1) > 0 THEN
      delta := '{}'::jsonb;
      FOREACH col IN ARRAY additive LOOP
        delta := delta || jsonb_build_object(
          col, coalesce((rec->>col)::numeric, 0) - coalesce((old_rec->>col)::numeric, 0));
      END LOOP;
    END IF;
  END IF;
  INSERT INTO replication_changes ("tenantId", tbl, pk, op, "row", delta, "changedAt", origin)
  VALUES (tid, TG_TABLE_NAME, pkv, left(TG_OP, 1),
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec - excluded END,
          delta, at, node);
  INSERT INTO replication_rows (tbl, pk, "changedAt", origin)
  VALUES (TG_TABLE_NAME, pkv::text, at, node)
  ON CONFLICT (tbl, pk) DO UPDATE SET "changedAt" = EXCLUDED."changedAt", origin = EXCLUDED.origin;
  RETURN NULL;
END
$$;
