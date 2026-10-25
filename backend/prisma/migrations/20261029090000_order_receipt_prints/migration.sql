-- Customer receipts printed per order: the second and later ones are marked "NUSXA". Existing orders start at 0.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "receiptPrints" INTEGER NOT NULL DEFAULT 0;
