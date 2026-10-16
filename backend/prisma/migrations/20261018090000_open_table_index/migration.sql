-- Fast lookup of the active order of a table (reopening a table restores it).
CREATE INDEX IF NOT EXISTS "orders_open_table_idx"
  ON "orders" ("tenantId", "tableId")
  WHERE "tableId" IS NOT NULL AND "status" NOT IN ('COMPLETED', 'CANCELLED');
