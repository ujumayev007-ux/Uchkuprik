-- Cashier cost visibility is expressed as catalog features; the JSON column was unused.
ALTER TABLE "control_policies" DROP COLUMN "financial",
ADD COLUMN "minVersionFrom" TIMESTAMP(3);
