-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "discountBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountFixed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_rule" CHECK ("discountBp" BETWEEN 0 AND 10000 AND "discountFixed" >= 0);
